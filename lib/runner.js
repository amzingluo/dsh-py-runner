/**
 * dsh-py-runner — process manager for one Python run.
 *
 * A run is a child process plus an ordered, replayable chunk log. The SSE
 * route attaches at any time and replays from `from` (a sequence number), so a
 * tab switch, a page reload or a re-mount never loses output that is still in
 * the bounded log.
 *
 * Zero dependencies: node builtins only (third-party DSH plugins cannot import
 * anything from `@deepseek-ai/*` — that all lives inside app.asar).
 */
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Hard cap on one run's log so a runaway print loop cannot eat host memory. */
const MAX_CHUNKS = 20000
const MAX_CHARS = 800000
/** Runs kept for replay. Older ones are dropped (their child is killed). */
const MAX_RUNS = 8

/**
 * @typedef {{ seq: number, stream: 'stdout'|'stderr'|'meta', text: string }} Chunk
 * @typedef {{
 *   id: string, file: string, cwd: string, mode: 'run'|'debug', python: string,
 *   status: 'running'|'exited', quitting: boolean, chunks: Chunk[], seq: number, dropped: number,
 *   chars: number, startedAt: number, endedAt?: number, exit?: { code: number|null, signal: string|null },
 *   listeners: Set<(event: object) => void>, child: import('node:child_process').ChildProcess,
 * }} Run
 */

/** @returns {ReturnType<typeof createRunner>} */
export function createRunner() {
  /** @type {Map<string, Run>} */
  const runs = new Map()
  /** @type {string[]} */
  const order = []

  /** @param {Run} run @param {object} event */
  function emit(run, event) {
    for (const listener of run.listeners) {
      try {
        listener(event)
      } catch {
        /* one dead SSE socket must not break the run */
      }
    }
  }

  /**
   * Append one chunk and broadcast it. Trimming is head-first, and `dropped`
   * records the first sequence number still available.
   * @param {Run} run
   * @param {'stdout'|'stderr'|'meta'} stream
   * @param {string} text
   */
  function push(run, stream, text) {
    if (text === '' || text === undefined || text === null) return
    const chunk = { seq: run.seq++, stream, text }
    run.chunks.push(chunk)
    run.chars += text.length
    emit(run, { type: 'chunk', seq: chunk.seq, stream, text })
    while (run.chunks.length > MAX_CHUNKS || (run.chars > MAX_CHARS && run.chunks.length > 1)) {
      const gone = /** @type {Chunk} */ (run.chunks.shift())
      run.chars -= gone.text.length
      run.dropped = gone.seq + 1
    }
  }

  /** @param {string} id */
  function get(id) {
    return runs.get(id)
  }

  /**
   * Start one run.
   * @param {{ python: string, cwd: string, file: string, mode?: 'run'|'debug', extraArgs?: string[] }} options
   * @returns {Run}
   */
  function start(options) {
    const mode = options.mode === 'debug' ? 'debug' : 'run'
    const args = ['-u']
    if (mode === 'debug') args.push('-m', 'pdb')
    if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs)
    args.push(options.file)

    /** @type {Run} */
    const run = {
      id: randomUUID().slice(0, 8),
      file: options.file,
      cwd: options.cwd,
      mode,
      python: options.python,
      status: 'running',
      /** set once pdb has been asked to quit after the program finished */
      quitting: false,
      chunks: [],
      seq: 0,
      dropped: 0,
      chars: 0,
      startedAt: Date.now(),
      listeners: new Set(),
      // assigned below
      // @ts-ignore
      child: null,
    }

    const child = spawn(options.python, args, {
      cwd: options.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    run.child = child
    if (child.stdout) child.stdout.setEncoding('utf8')
    if (child.stderr) child.stderr.setEncoding('utf8')

    runs.set(run.id, run)
    order.push(run.id)
    while (order.length > MAX_RUNS) {
      const oldest = order.shift()
      const dropped = oldest === undefined ? undefined : runs.get(oldest)
      if (dropped !== undefined) {
        try {
          dropped.child.kill()
        } catch {
          /* already gone */
        }
        runs.delete(dropped.id)
      }
    }

    emit(run, {
      type: 'start',
      id: run.id,
      file: run.file,
      cwd: run.cwd,
      mode: run.mode,
      python: run.python,
      startedAt: run.startedAt,
    })

    child.stdout?.on('data', (text) => {
      push(run, 'stdout', String(text))
      watchDebug(run, String(text))
    })
    child.stderr?.on('data', (text) => {
      push(run, 'stderr', String(text))
      watchDebug(run, String(text))
    })

    child.on('error', (error) => {
      push(run, 'meta', `无法启动 Python：${error.message}\n`)
      finish(run, -1, null)
    })

    // `close` (not `exit`) guarantees the pipes are drained: every byte the
    // child wrote has already been pushed by the time this fires.
    child.on('close', (code, signal) => finish(run, code, signal))

    return run
  }

  /**
   * `python -m pdb script.py` restarts the script instead of exiting once the
   * program finishes, so a debug session would hang open forever. The banner it
   * prints at that moment is the only signal available on the pipe, so quit the
   * debugger there — a restart destroys the very locals the user was inspecting.
   * @param {Run} run
   * @param {string} text
   */
  function watchDebug(run, text) {
    if (run.mode !== 'debug' || run.status !== 'running' || run.quitting === true) return
    if (!text.includes('The program finished and will be restarted')) return
    run.quitting = true
    setTimeout(() => {
      push(run, 'meta', '\n[程序已结束，自动退出调试器]\n')
      try {
        run.child.stdin?.write('q\n')
      } catch {
        /* the process may already be gone */
      }
    }, 60)
  }

  /**
   * @param {Run} run
   * @param {number|null} code
   * @param {string|null} signal
   */
  function finish(run, code, signal) {
    if (run.status === 'exited') return
    run.status = 'exited'
    run.endedAt = Date.now()
    run.exit = { code, signal }
    emit(run, {
      type: 'exit',
      id: run.id,
      code,
      signal,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      ms: run.endedAt - run.startedAt,
    })
  }

  /** @param {string} id */
  function stop(id) {
    const run = runs.get(id)
    if (run === undefined || run.status === 'exited') return false
    push(run, 'meta', '\n[已请求停止]\n')
    const pid = run.child.pid
    if (pid === undefined) return false
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
        /* the close handler reports the exit; nothing to do here */
      })
    } else {
      try {
        run.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    return true
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  function write(id, text) {
    const run = runs.get(id)
    if (run === undefined || run.status === 'exited') return false
    try {
      run.child.stdin?.write(text)
      return true
    } catch {
      return false
    }
  }

  /**
   * Replay the log from `from`, then stream live events. The listener may be
   * invoked synchronously during this call (replay), so a caller must not rely
   * on the return value inside its own callback.
   * @param {string} id
   * @param {number} from
   * @param {(event: object) => void} listener
   * @returns {{ ok: boolean, off: () => void, done?: boolean, run?: Run }}
   */
  function subscribe(id, from, listener) {
    const run = runs.get(id)
    if (run === undefined) return { ok: false, off: () => {}, done: true }
    const startAt = Number.isFinite(from) ? Math.max(0, from) : 0
    for (const chunk of run.chunks) {
      if (chunk.seq >= startAt) listener({ type: 'chunk', seq: chunk.seq, stream: chunk.stream, text: chunk.text })
    }
    if (run.status === 'exited' && run.exit !== undefined) {
      listener({
        type: 'exit',
        id: run.id,
        code: run.exit.code,
        signal: run.exit.signal,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        ms: (run.endedAt ?? Date.now()) - run.startedAt,
      })
      // The listener already saw the whole log and the exit; a caller streaming
      // this to a socket can close immediately instead of waiting for silence.
      return { ok: true, off: () => {}, run, done: true }
    }
    run.listeners.add(listener)
    return {
      ok: true,
      run,
      done: false,
      off: () => {
        run.listeners.delete(listener)
      },
    }
  }

  return { start, stop, write, get, subscribe }
}
