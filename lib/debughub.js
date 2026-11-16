/**
 * dsh-py-runner — one debug session plus its replayable event log.
 *
 * The browser talks to this through the same SSE stream the plain runner uses:
 * program output arrives as `chunk` events, and everything the debugger does
 * (stopped / continued / terminated / thread) arrives as `debug` events. Both
 * share one sequence space so a reload can replay from any position.
 *
 * Zero dependencies beyond lib/dap.js.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createDebugSession } from './dap.js'

const MAX_ENTRIES = 20000
const MAX_CHARS = 800000
const MAX_SESSIONS = 4

/** Commands the browser may forward; anything else would be an open door. */
const ALLOWED_COMMANDS = new Set([
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'pause',
  'threads',
  'stackTrace',
  'scopes',
  'variables',
  'evaluate',
  'setVariable',
  'source',
  'setBreakpoints',
  'setExceptionBreakpoints',
  'exceptionInfo',
  'restart',
])

/** @returns {ReturnType<typeof createDebugHub>} */
export function createDebugHub() {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {string[]} */
  const order = []
  /** @type {Map<string, { at: number, version: string|null }>} */
  const checks = new Map()

  function emit(state, event) {
    const entry = { seq: state.seq++, event }
    state.log.push(entry)
    if (event.type === 'chunk') state.chars += event.text.length
    while (state.log.length > MAX_ENTRIES || (state.chars > MAX_CHARS && state.log.length > 1)) {
      const gone = state.log.shift()
      if (gone.event.type === 'chunk') state.chars -= gone.event.text.length
      state.dropped = gone.seq + 1
    }
    for (const listener of state.listeners) {
      try {
        listener({ ...event, seq: entry.seq })
      } catch {
        /* one dead socket must not break the session */
      }
    }
  }

  function pushChunk(state, stream, text) {
    if (!text) return
    emit(state, { type: 'chunk', stream, text })
  }

  /** `python -c "import debugpy"` — cached, because the UI asks on every render. */
  function check(python) {
    if (!python) return { installed: false, version: null }
    const cached = checks.get(python)
    if (cached && Date.now() - cached.at < 30000) return { installed: cached.version !== null, version: cached.version }
    let version = null
    try {
      if (existsSync(python) || /^[a-zA-Z]+$/.test(python)) {
        const probe = spawnSync(python, ['-c', 'import debugpy; print(debugpy.__version__)'], {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        })
        if (probe.status === 0) version = String(probe.stdout || '').trim() || 'unknown'
      }
    } catch {
      version = null
    }
    checks.set(python, { at: Date.now(), version })
    return { installed: version !== null, version }
  }

  /**
   * Start a debug session for one file.
   * @param {{ python: string, cwd: string, file: string, breakpoints?: Record<string, number[]>, filters?: string[], args?: string[] }} options
   */
  async function start(options) {
    const state = {
      id: `dbg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      python: options.python,
      cwd: options.cwd,
      file: options.file,
      status: 'starting',
      log: [],
      seq: 0,
      chars: 0,
      dropped: 0,
      startedAt: Date.now(),
      endedAt: 0,
      listeners: new Set(),
      frame: null,
      session: null,
      error: '',
    }
    sessions.set(state.id, state)
    order.push(state.id)
    while (order.length > MAX_SESSIONS) {
      const oldest = order.shift()
      const stale = oldest === undefined ? undefined : sessions.get(oldest)
      if (stale !== undefined) {
        try {
          await stale.session?.stop()
        } catch {
          /* already gone */
        }
        sessions.delete(stale.id)
      }
    }

    const session = createDebugSession({
      id: state.id,
      python: options.python,
      cwd: options.cwd,
      file: options.file,
      args: options.args,
      onEvent(event, payload) {
        if (event === 'output') {
          const stream = payload.category === 'stderr' ? 'stderr' : payload.category === 'console' ? 'meta' : 'stdout'
          pushChunk(state, stream, payload.text)
          return
        }
        if (event === 'started') {
          state.status = 'running'
          emit(state, { type: 'debug', event: 'started', body: { python: options.python, file: options.file } })
          return
        }
        if (event === 'stopped') {
          state.status = 'paused'
          emit(state, { type: 'debug', event: 'stopped', body: payload })
          return
        }
        if (event === 'continued') {
          state.status = 'running'
          emit(state, { type: 'debug', event: 'continued', body: payload })
          return
        }
        if (event === 'exited') {
          state.exitCode = payload.exitCode ?? null
          emit(state, { type: 'debug', event: 'exited', body: payload })
          return
        }
        if (event === 'terminated') {
          finish(state, payload?.code ?? null)
          return
        }
        if (event === 'error') {
          state.error = payload.message
          pushChunk(state, 'meta', `调试器错误：${payload.message}\n`)
          return
        }
        if (event === 'thread') {
          emit(state, { type: 'debug', event: 'thread', body: payload })
        }
      },
    })
    state.session = session

    try {
      await session.start({ breakpoints: options.breakpoints || {}, exceptionFilters: options.filters || ['uncaught'] })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.error = message
      pushChunk(state, 'meta', `${message}\n`)
      finish(state, null)
      return state
    }
    return state
  }

  function finish(state, code) {
    if (state.status === 'terminated') return
    state.status = 'terminated'
    state.endedAt = Date.now()
    const exitCode = code === null || code === undefined ? state.exitCode ?? null : code
    emit(state, {
      type: 'exit',
      code: exitCode,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      ms: state.endedAt - state.startedAt,
    })
  }

  /** @returns {any} */
  function get(id) {
    return sessions.get(id)
  }

  /**
   * Forward one DAP command. The client sends the command name plus arguments,
   * and only names on the allowlist get through.
   */
  async function command(id, name, args) {
    // A command name that is not on the allowlist is a client bug, not a
    // session-state problem, so it is reported even after the session ended.
    if (!ALLOWED_COMMANDS.has(name)) throw new Error(`不支持的命令：${name}`)
    const state = sessions.get(id)
    if (state === undefined) throw new Error(`找不到调试会话：${id}`)
    if (state.status === 'terminated') throw new Error('调试会话已经结束')
    const response = await state.session.command(name, args || {})
    if (name === 'stackTrace' && response.ok) {
      state.frame = response.body.stackFrames?.[0] ?? null
    }
    return { ok: response.ok, body: response.body, message: response.message }
  }

  async function setBreakpoints(id, file, lines) {
    const state = sessions.get(id)
    if (state === undefined) return { ok: false, breakpoints: [] }
    if (state.status === 'terminated') return { ok: false, breakpoints: [] }
    const breakpoints = await state.session.setBreakpoints(file, lines)
    return { ok: true, breakpoints }
  }

  async function stop(id) {
    const state = sessions.get(id)
    if (state === undefined) return { ok: false }
    await state.session.stop()
    finish(state, null)
    return { ok: true }
  }

  /**
   * Replay the log from `from`, then stream live. Mirrors runner.subscribe:
   * the listener may fire synchronously, and `done` means "replay was all".
   */
  function subscribe(id, from, listener) {
    const state = sessions.get(id)
    if (state === undefined) return { ok: false, off: () => {}, done: true }
    const startAt = Number.isFinite(from) ? Math.max(0, from) : 0
    for (const entry of state.log) {
      if (entry.seq >= startAt) listener({ ...entry.event, seq: entry.seq })
    }
    if (state.status === 'terminated') {
      listener({
        type: 'exit',
        code: null,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        ms: state.endedAt - state.startedAt,
      })
      return { ok: true, off: () => {}, done: true, state }
    }
    state.listeners.add(listener)
    return {
      ok: true,
      done: false,
      state,
      off: () => {
        state.listeners.delete(listener)
      },
    }
  }

  function prune() {
    for (const [id, state] of sessions) {
      if (state.status === 'terminated' && Date.now() - (state.endedAt || state.startedAt) > 10 * 60 * 1000) {
        sessions.delete(id)
        const index = order.indexOf(id)
        if (index >= 0) order.splice(index, 1)
      }
    }
  }

  return { start, stop, command, setBreakpoints, get, subscribe, check, prune }
}
