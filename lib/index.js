/**
 * dsh-py-runner — host half.
 *
 * Serves one small JSON API on the shared web server under
 * `/dsh-py-runner/api/<method>`, plus one SSE stream for live output:
 *
 *   info      { sessionId, cwd? }            → cwd, interpreters, *.py files
 *   read      { path, cwd? }                 → { path, content, mtimeMs, size }
 *   save      { path, content, cwd? }        → { path, mtimeMs }
 *   run       { path, mode, python, cwd? }   → { id, python, mode }
 *   stop      { id }                         → { ok }
 *   stdin     { id, text }                   → { ok }
 *   debug/start       { path, python, breakpoints, filters, cwd? }
 *   debug/command     { id, command, args }  → { ok, body, message }
 *   debug/breakpoints { id, path, lines }    → { ok, breakpoints }
 *   debug/stop        { id }                 → { ok }
 *   debug/check       { python }             → { installed, version }
 *   events    GET ?id=&from=                 → text/event-stream
 *
 * Disciplines (the ones every healthy DSH plugin follows):
 *   1. `apply()` never throws — a throw fails the loader entry and the boot
 *      audit reports "Failed to load plugins".
 *   2. Only inject services that are certainly provided: `webServer` (and
 *      optionally `sessions` / `connection`, looked up with `ctx.get`).
 *   3. Every path is contained to the session's workspace before it is read,
 *      written or executed.
 *
 * Zero runtime dependencies: node:* builtins only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

import { createRunner } from './runner.js'
import { createDebugHub } from './debughub.js'

/** Route prefix of the JSON API. */
export const API_PREFIX = '/dsh-py-runner/api'

/** Largest file this plugin will read into the editor (the GUI holds it as a string). */
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024
/** Workspace walk bounds for the file picker. */
const MAX_FILES = 500
const WALK_DEPTH = 3
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.obsidian', 'dist', 'build', '.next',
])
/** Python files bigger than this are listed but not offered as "run this". */
const WALK_MAX_BYTES = 8 * 1024 * 1024

/** @typedef {{ path: string, version: string, label: string }} Interpreter */

/**
 * Decode a Python source file without guessing wrongly.
 *
 * These workspaces are mixed: some scripts are UTF-8, older ones are GBK
 * (`#encoding:gbk`). Decoding everything as UTF-8 turns the Chinese comments
 * into replacement characters, so try strict UTF-8 first and fall back to GBK.
 * We never write a non-UTF-8 file back: without an encoder the round trip is
 * lossy, and silently re-encoding someone's script is worse than refusing.
 *
 * @param {Buffer} buffer
 * @returns {{ content: string, encoding: 'utf-8' | 'gbk' | 'binary' }}
 */
function decodeSource(buffer) {
  const bytes =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    /* not UTF-8 */
  }
  try {
    return { content: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' }
  } catch {
    return { content: bytes.toString('latin1'), encoding: 'binary' }
  }
}

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '')

/**
 * Warn once, never throw: log noise is a bug, silence about a broken mount is worse.
 * @param {string} message
 */
function warn(message) {
  try {
    console.warn(`[dsh-py-runner] ${message}`)
  } catch {
    /* nothing to do */
  }
}

/**
 * Absolute, existing directory or throw.
 * @param {string} value
 * @param {string} what
 */
function requireDir(value, what) {
  if (value === '') throw new Error(`${what} 不能为空`)
  const absolute = resolve(value)
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    throw new Error(`${what} 不存在：${absolute}`)
  }
  if (!stats.isDirectory()) throw new Error(`${what} 不是目录：${absolute}`)
  return absolute
}

/**
 * Resolve a request path against the workspace and refuse anything outside it.
 * @param {string} cwd
 * @param {string} candidate
 */
function requireInside(cwd, candidate) {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
  const root = resolve(cwd)
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`路径不在工作区内：${candidate}`)
  }
  return absolute
}

/**
 * The session's workspace directory: the host's committed cwd first, the
 * client's summary second, the payload's own `cwd` last.
 * @param {any} ctx
 * @param {string} sessionId
 * @param {string} clientCwd
 */
function sessionCwdOf(ctx, sessionId, clientCwd) {
  if (sessionId !== '') {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      const committed = session === undefined ? undefined : ctx.get?.('workingDirectory')?.get?.(session)
      const header = session?.header?.cwd
      for (const value of [committed, header]) {
        if (typeof value === 'string' && value !== '') return requireDir(value, '工作区目录')
      }
    } catch (error) {
      warn(`读取会话工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (clientCwd !== '') return requireDir(clientCwd, '工作区目录')
  throw new Error('无法确定工作区目录，请传入 cwd')
}

/**
 * Interpreter candidates, in the order a Chinese Windows dev box usually wants
 * them. Probed once and cached; a candidate that cannot print its version is
 * dropped instead of being offered.
 * @returns {Interpreter[]}
 */
let interpreterCache = { at: 0, list: /** @type {Interpreter[]} */ ([]) }

function interpreterCandidates(configured) {
  /** @type {{ path: string, label: string }[]} */
  const candidates = []
  const seen = new Set()
  /** @param {string} path @param {string} label */
  const push = (path, label) => {
    if (path === '') return
    const key = path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ path, label })
  }

  push(text(configured), '插件配置')
  push(text(process.env.DSH_PYTHON), 'DSH_PYTHON')
  push(text(process.env.PYTHON), 'PYTHON')
  push('D:\\Miniconda3\\python.exe', 'Miniconda3')
  push('D:\\Anaconda3\\python.exe', 'Anaconda3')
  push(join(homedir(), 'miniconda3', 'python.exe'), 'miniconda3')
  push(join(homedir(), 'anaconda3', 'python.exe'), 'anaconda3')

  // DSH's own bundled runtime (numpy/pandas, no scipy/matplotlib).
  try {
    const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
    for (const entry of readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      push(join(runtimes, entry.name, 'dependencies', 'python', 'python.exe'), `DSH ${entry.name}`)
    }
  } catch {
    /* no bundled runtime: normal on other installs */
  }

  push('python', 'PATH python')
  push('python3', 'PATH python3')
  return candidates
}

/** @param {string} configured */
function interpretersOf(configured) {
  const now = Date.now()
  if (now - interpreterCache.at < 30000 && interpreterCache.list.length > 0) return interpreterCache.list
  /** @type {Interpreter[]} */
  const list = []
  for (const candidate of interpreterCandidates(configured)) {
    if (candidate.label !== 'PATH python' && candidate.label !== 'PATH python3' && !existsSync(candidate.path)) continue
    try {
      const probe = spawnSync(candidate.path, ['-c', 'import sys;print(sys.version.split()[0])'], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
      })
      if (probe.status !== 0) continue
      const version = String(probe.stdout ?? '').trim().split(/\r?\n/).pop() ?? ''
      if (version === '') continue
      list.push({ path: candidate.path, version, label: candidate.label })
    } catch {
      /* not this one */
    }
  }
  interpreterCache = { at: now, list }
  return list
}

/**
 * Walk the workspace for `.py` files (bounded depth and count).
 * @param {string} root
 */
function listPythonFiles(root) {
  /** @type {{ path: string, size: number }[]} */
  const files = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > WALK_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (extname(entry.name).toLowerCase() !== '.py') continue
      let size = 0
      try {
        size = statSync(full).size
      } catch {
        continue
      }
      if (size > WALK_MAX_BYTES) continue
      const relative = full.slice(root.length + 1).split(sep).join('/')
      files.push({ path: relative, size })
    }
  }
  walk(root, 0)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
function json(response, status, body) {
  try {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch {
    /* the socket may already be gone */
  }
}

/**
 * Enforce the GUI-browser cookie on mutating calls when this composition
 * exposes a Connection service. Reads stay open.
 * @param {any} ctx
 * @param {any} scoped
 * @param {import('node:http').IncomingMessage} request
 */
function isBrowserSession(ctx, scoped, request) {
  /** @type {any} */
  let connection = null
  for (const scope of [scoped, ctx]) {
    try {
      const found = scope?.get?.('connection')
      if (found !== null && found !== undefined) {
        connection = found
        break
      }
    } catch {
      /* a context without that service is normal */
    }
  }
  const auth = connection?.browserAuth
  if (auth === null || auth === undefined || typeof auth.isAuthenticated !== 'function') return null
  let secure = false
  try {
    secure = scoped?.get?.('webServer')?.protocol === 'https:'
  } catch {
    secure = false
  }
  try {
    return auth.isAuthenticated(request, secure) === true
  } catch {
    return false
  }
}

/** @param {import('node:http').IncomingMessage} request @param {number} [limit] */
function readBody(request, limit = 8 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolvePromise({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolvePromise(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Mount the routes.
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
function mount(ctx, config) {
  const runner = createRunner()
  const debug = createDebugHub()
  const configuredPython = text(config?.python)
  const configuredCwd = text(config?.cwd)
  const pipIndex = text(config?.pipIndex) || 'https://mirrors.aliyun.com/pypi/simple'

  /** @type {Record<string, (payload: any, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => any>} */
  const api = {
    async info(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      return {
        cwd,
        interpreters: interpretersOf(configuredPython),
        files: listPythonFiles(cwd),
      }
    },

    async read(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const path = requireInside(cwd, text(payload.path))
      const stats = statSync(path)
      if (!stats.isFile()) throw new Error('不是文件')
      if (stats.size > MAX_EDITABLE_BYTES) throw new Error(`文件太大（${Math.round(stats.size / 1024)} KB），无法在侧边栏打开`)
      const decoded = decodeSource(readFileSync(path))
      return {
        path,
        relative: path.slice(cwd.length + 1).split(sep).join('/'),
        content: decoded.content,
        encoding: decoded.encoding,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      }
    },

    async save(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const path = requireInside(cwd, text(payload.path))
      const content = typeof payload.content === 'string' ? payload.content : ''
      if (existsSync(path)) {
        const current = decodeSource(readFileSync(path))
        if (current.encoding !== 'utf-8') {
          throw new Error(
            `这个文件是 ${current.encoding.toUpperCase()} 编码，写回会破坏它；已在侧边栏设为只读，请用其他编辑器修改`,
          )
        }
      }
      writeFileSync(path, content, 'utf8')
      return { path, encoding: 'utf-8', mtimeMs: statSync(path).mtimeMs, size: Buffer.byteLength(content) }
    },

    async run(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const path = requireInside(cwd, text(payload.path))
      if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
      const mode = payload.mode === 'debug' ? 'debug' : 'run'
      const interpreters = interpretersOf(configuredPython)
      const requested = text(payload.python)
      const chosen = requested !== '' ? requested : interpreters[0]?.path ?? 'python'
      if (!existsSync(chosen) && chosen === requested) throw new Error(`Python 解释器不存在：${chosen}`)
      const run = runner.start({
        python: chosen,
        cwd: dirname(path) === '' ? cwd : cwd,
        file: path,
        mode,
      })
      return { id: run.id, python: chosen, mode, file: path, cwd }
    },

    async stop(payload) {
      const id = text(payload.id)
      return { ok: runner.stop(id) }
    },

    async stdin(payload) {
      const id = text(payload.id)
      const value = typeof payload.text === 'string' ? payload.text : ''
      return { ok: runner.write(id, value) }
    },

    /** Does this interpreter have debugpy? Drives the hint + install button. */
    async 'debug/check'(payload) {
      const interpreters = interpretersOf(configuredPython)
      const requested = text(payload.python)
      const chosen = requested !== '' ? requested : interpreters[0]?.path ?? 'python'
      return { python: chosen, ...debug.check(chosen) }
    },

    async 'debug/start'(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const path = requireInside(cwd, text(payload.path))
      if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
      const interpreters = interpretersOf(configuredPython)
      const requested = text(payload.python)
      const chosen = requested !== '' ? requested : interpreters[0]?.path ?? 'python'
      if (requested !== '' && !existsSync(requested)) throw new Error(`Python 解释器不存在：${chosen}`)
      const capability = debug.check(chosen)
      if (!capability.installed) {
        throw new Error(
          `这个解释器没有 debugpy（${chosen}）。调试需要它：点「安装 debugpy」自动装，或手动运行 "${chosen}" -m pip install debugpy`,
        )
      }
      const breakpoints = {}
      const raw = payload.breakpoints && typeof payload.breakpoints === 'object' ? payload.breakpoints : {}
      for (const [file, lines] of Object.entries(raw)) {
        if (!Array.isArray(lines)) continue
        const absolute = requireInside(cwd, text(file))
        breakpoints[absolute] = lines.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      }
      const filters = Array.isArray(payload.filters) ? payload.filters.map(String) : ['uncaught']
      const args = Array.isArray(payload.args) ? payload.args.map(String) : []
      const state = await debug.start({ python: chosen, cwd, file: path, breakpoints, filters, args })
      if (state.status === 'terminated' && state.error !== '') throw new Error(state.error)
      return { id: state.id, python: chosen, file: path, cwd }
    },

    async 'debug/command'(payload) {
      const id = text(payload.id)
      const name = text(payload.command)
      const args = payload.args && typeof payload.args === 'object' ? payload.args : {}
      return debug.command(id, name, args)
    },

    async 'debug/breakpoints'(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const id = text(payload.id)
      const path = requireInside(cwd, text(payload.path))
      const lines = Array.isArray(payload.lines) ? payload.lines.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
      return debug.setBreakpoints(id, path, lines)
    },

    async 'debug/stop'(payload) {
      return debug.stop(text(payload.id))
    },

    /** Streams `pip install debugpy` through the normal run/SSE path. */
    async 'debug/install'(payload) {
      const cwd = sessionCwdOf(ctx, text(payload.sessionId), text(payload.cwd) || configuredCwd)
      const interpreters = interpretersOf(configuredPython)
      const requested = text(payload.python)
      const chosen = requested !== '' ? requested : interpreters[0]?.path ?? 'python'
      const run = runner.start({
        python: chosen,
        cwd,
        mode: 'run',
        file: 'pip install debugpy',
        args: ['-m', 'pip', 'install', 'debugpy', '-i', pipIndex, '--disable-pip-version-check', '--no-input'],
      })
      return { id: run.id, python: chosen }
    },
  }

  const register = () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://dsh.internal')
          const pathname = url.pathname
          const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : ''

          // ── live output ──────────────────────────────────────────────────
          if (method === 'events') {
            if (request.method !== 'GET') {
              json(response, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const id = url.searchParams.get('id') ?? ''
            const from = Number(url.searchParams.get('from') ?? '0')
            try {
              response.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
              })
              response.write(': connected\n\n')
              /** @param {object} event */
              const send = (event) => {
                try {
                  response.write(`data: ${JSON.stringify(event)}\n\n`)
                } catch {
                  /* socket gone */
                }
              }
              let subscription = runner.subscribe(id, from, send)
              // Debug sessions share the stream shape (chunk / debug / exit).
              if (!subscription.ok) subscription = debug.subscribe(id, from, send)
              if (!subscription.ok) {
                send({ type: 'error', message: `找不到运行中的任务：${id}` })
                send({ type: 'exit', code: null, ms: 0 })
                response.end()
                return
              }
              if (subscription.done === true) {
                // Replay was the whole story: the process is already gone.
                setTimeout(() => {
                  try {
                    response.end()
                  } catch {
                    /* socket gone */
                  }
                }, 30)
                return
              }
              const heartbeat = setInterval(() => {
                try {
                  response.write(': ping\n\n')
                } catch {
                  /* socket gone */
                }
              }, 15000)
              const cleanup = () => {
                clearInterval(heartbeat)
                subscription.off()
              }
              request.on('close', cleanup)
              response.on('close', cleanup)
            } catch (error) {
              warn(`events 失败：${error instanceof Error ? error.message : String(error)}`)
            }
            return
          }

          // ── JSON methods ─────────────────────────────────────────────────
          if (request.method !== 'POST') {
            json(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const handler = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') {
            json(response, 404, { ok: false, error: `未知方法：${method}` })
            return
          }
          const browser = isBrowserSession(ctx, ctx, request)
          if (browser === false) {
            json(response, 401, { ok: false, error: '该操作必须来自 DSH 窗口' })
            return
          }
          try {
            const payload = await readBody(request)
            const result = await handler(payload, request, response)
            if (result !== undefined) json(response, 200, { ok: true, result })
          } catch (error) {
            json(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      })

  // Disposal via `effect` is the normal path; a context that only registers
  // (tests, older hosts) still works, it just cannot un-register.
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-py-runner: /dsh-py-runner/api routes')
  else register()
}

/**
 * @param {any} ctx - host cordis context.
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  if (typeof ctx?.inject !== 'function') {
    warn('host context 缺少 inject，插件未挂载')
    return
  }
  try {
    ctx.inject(['webServer'], (scoped) => {
      try {
        if (typeof scoped?.webServer?.register !== 'function') return
        mount(scoped, config ?? {})
      } catch (error) {
        warn(`路由挂载失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    warn(`无法注入 webServer：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-py-runner'
