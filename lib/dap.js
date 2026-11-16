/**
 * DAP client for debugpy — the piece that turns "python -m pdb in a terminal"
 * into a real debugger (breakpoints, stepping, variables, evaluate).
 *
 * debugpy ships a Debug Adapter Protocol server that speaks JSON over stdio:
 *
 *   python -Xfrozen_modules=off -m debugpy.adapter
 *
 * We spawn it, send `initialize` → `launch` → `setBreakpoints` →
 * `configurationDone`, and from then on the adapter pushes `stopped` /
 * `continued` / `output` / `terminated` events while we send commands such as
 * `next` / `stepIn` / `stackTrace` / `variables`.
 *
 * Zero dependencies: the protocol is a length-prefixed header plus a JSON body.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

const REQUEST_TIMEOUT = 20000
const MAX_HEADER_BYTES = 64 * 1024

/** Build the adapter command line. Frozen modules would hide stdlib breakpoints. */
export function adapterArgv(python, extra = []) {
  return ['-Xfrozen_modules=off', '-m', 'debugpy.adapter', ...extra]
}

/**
 * Create a debug session handle. Nothing is spawned until `start()` is called,
 * so the caller can register listeners first.
 */
export function createDebugSession(options = {}) {
  const python = options.python
  const cwd = options.cwd || process.cwd()
  const file = options.file
  const args = Array.isArray(options.args) ? options.args.map(String) : []
  const env = options.env || {}
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}

  const session = {
    id: options.id || `dbg-${Date.now().toString(36)}`,
    python,
    file,
    cwd,
    child: null,
    status: 'idle',
    seq: 0,
    lastSeq: 0,
    exited: false,
    outputSeq: 0,
    stopCount: 0,
  }

  const listeners = new Map()
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  let fatal = null

  function emit(event, payload) {
    const list = listeners.get(event)
    if (list) {
      for (const fn of list.slice()) {
        try {
          fn(payload)
        } catch {
          /* a listener must never break the protocol loop */
        }
      }
    }
    try {
      onEvent(event, payload)
    } catch {
      /* same */
    }
  }

  function fail(error) {
    if (fatal) return
    fatal = error instanceof Error ? error : new Error(String(error))
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(fatal)
    }
    pending.clear()
    emit('error', { message: fatal.message })
  }

  function send(command, commandArgs) {
    if (!session.child || session.exited) {
      return Promise.reject(new Error('调试会话尚未启动或已经结束'))
    }
    const seq = ++session.seq
    const message = { seq, type: 'request', command }
    if (commandArgs !== undefined) message.arguments = commandArgs
    const body = JSON.stringify(message)
    const framed = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(seq)
        reject(new Error(`调试器没有响应 ${command}（超过 ${REQUEST_TIMEOUT / 1000} 秒）`))
      }, REQUEST_TIMEOUT)
      pending.set(seq, { resolve, reject, timer, command })
      try {
        session.child.stdin.write(framed)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(seq)
        reject(error)
      }
    })
  }

  function handleMessage(message) {
    if (message.type === 'response') {
      const entry = pending.get(message.request_seq)
      if (!entry) return
      pending.delete(message.request_seq)
      clearTimeout(entry.timer)
      if (message.success === false) {
        const text = message.message || message.body?.error?.format || `${entry.command} 失败`
        entry.resolve({ ok: false, body: message.body || {}, message: text })
      } else {
        entry.resolve({ ok: true, body: message.body || {}, message: '' })
      }
      return
    }
    if (message.type !== 'event') return
    const name = message.event
    const body = message.body || {}
    // debugpy chatters about sockets and modules; none of it belongs in a UI.
    if (name === 'debugpySockets' || name === 'module' || name === 'loadedSource' || name === 'process') return
    if (name === 'output') {
      const category = body.category || 'stdout'
      // debugpy reports its own name as telemetry; that is not program output.
      if (category === 'telemetry') return
      const text = typeof body.output === 'string' ? body.output : ''
      if (!text) return
      session.outputSeq += 1
      emit('output', { category, text, seq: session.outputSeq })
      return
    }
    if (name === 'stopped') {
      session.stopCount += 1
      session.status = 'stopped'
      emit('stopped', {
        reason: body.reason || 'breakpoint',
        threadId: body.threadId,
        allThreadsStopped: body.allThreadsStopped !== false,
        description: body.description,
        text: body.text,
        stopCount: session.stopCount,
      })
      return
    }
    if (name === 'continued') {
      session.status = 'running'
      emit('continued', { threadId: body.threadId })
      return
    }
    if (name === 'thread') {
      emit('thread', { reason: body.reason, threadId: body.threadId })
      return
    }
    if (name === 'exited') {
      session.status = 'exited'
      emit('exited', { exitCode: body.exitCode })
      return
    }
    if (name === 'terminated') {
      session.status = 'terminated'
      emit('terminated', {})
      return
    }
    if (name === 'initialized') {
      emit('initialized', {})
      return
    }
    emit('notice', { name, body })
  }

  function feed(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (buffer.length > MAX_HEADER_BYTES) fail(new Error('调试器发来的数据格式无法识别'))
        return
      }
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (buffer.length < start + length) return
      const payload = buffer.subarray(start, start + length).toString('utf8')
      buffer = buffer.subarray(start + length)
      let message
      try {
        message = JSON.parse(payload)
      } catch {
        continue
      }
      handleMessage(message)
    }
  }

  /** Spawn the adapter and walk it through initialize → launch → configurationDone. */
  async function start(config = {}) {
    if (session.child) throw new Error('调试会话已经在运行')
    const breakpointsByFile = config.breakpoints && typeof config.breakpoints === 'object' ? config.breakpoints : {}
    const child = spawn(python, adapterArgv(python), {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PYDEVD_DISABLE_FILE_VALIDATION: '1',
        PYTHONUNBUFFERED: '1',
      },
    })
    session.child = child
    session.status = 'starting'

    child.stdout.on('data', feed)
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        // debugpy writes its banner to stderr; the UI gets it as console output.
        emit('output', { category: 'console', text: `${line}\n`, seq: ++session.outputSeq })
      }
    })
    child.on('error', (error) => {
      session.exited = true
      fail(new Error(`无法启动调试器：${error.message}`))
      emit('terminated', {})
    })
    child.on('exit', (code, signal) => {
      session.exited = true
      session.status = 'terminated'
      emit('terminated', { code, signal })
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('调试器进程已退出'))
      }
      pending.clear()
    })

    const init = await send('initialize', {
      clientID: 'dsh-py-runner',
      clientName: 'DSH Python Runner',
      adapterID: 'python',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      locale: 'zh-CN',
    })
    if (!init.ok) throw new Error(init.message || '调试器初始化失败')

    const launched = send('launch', {
      type: 'python',
      request: 'launch',
      program: path.resolve(cwd, file),
      cwd,
      python,
      args,
      env: { ...env },
      console: 'internalConsole',
      justMyCode: false,
      redirectOutput: true,
      subProcess: false,
      gevent: false,
      django: false,
      jinja: false,
      showReturnValue: true,
    })

    // Breakpoints have to be in place before configurationDone, otherwise the
    // program can run past the first one.
    for (const [source, lines] of Object.entries(breakpointsByFile)) {
      await setBreakpoints(source, lines)
    }
    await send('setExceptionBreakpoints', { filters: config.exceptionFilters || ['uncaught'] })
    await send('configurationDone', {})

    const launchResponse = await launched
    if (!launchResponse.ok) throw new Error(launchResponse.message || '启动调试失败')
    session.status = 'running'
    emit('started', { id: session.id, python, file, cwd })
    return session
  }

  async function setBreakpoints(source, lines) {
    const filePath = path.resolve(cwd, source)
    const clean = Array.isArray(lines) ? lines.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
    const response = await send('setBreakpoints', {
      source: { path: filePath },
      breakpoints: clean.map((line) => ({ line })),
      lines: clean,
      sourceModified: false,
    })
    return response.ok ? response.body.breakpoints || [] : []
  }

  /** Generic passthrough — the UI drives stepping through this. */
  function command(name, commandArgs) {
    return send(name, commandArgs)
  }

  async function stop() {
    if (!session.child || session.exited) {
      session.status = 'terminated'
      return { ok: true }
    }
    session.status = 'stopping'
    try {
      await send('disconnect', { terminateDebuggee: true, restart: false })
    } catch {
      /* the adapter may already be gone */
    }
    const child = session.child
    setTimeout(() => {
      if (session.exited) return
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* best effort */
      }
    }, 1500)
    session.status = 'terminated'
    return { ok: true }
  }

  function on(event, listener) {
    const list = listeners.get(event)
    if (list) list.push(listener)
    else listeners.set(event, [listener])
    return () => {
      const current = listeners.get(event)
      if (!current) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  return {
    session,
    start,
    stop,
    command,
    setBreakpoints,
    on,
    get status() {
      return session.status
    },
  }
}
