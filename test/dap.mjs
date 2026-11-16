/**
 * DAP test for lib/dap.js — run with:
 *   node dsh-py-runner/test/dap.mjs
 *
 * Needs debugpy in the target interpreter (`pip install debugpy`). Without it
 * the file reports SKIP instead of failing, because the plugin itself degrades
 * to a hint when debugpy is missing.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDebugSession } from '../lib/dap.js'

const python = process.env.TEST_PYTHON || 'D:\\Miniconda3\\python.exe'
const dir = mkdtempSync(join(tmpdir(), 'py-dap-'))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`)
}

function hasDebugpy() {
  try {
    execFileSync(python, ['-c', 'import debugpy'], { stdio: 'ignore', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

if (!hasDebugpy()) {
  console.log(`SKIP  ${python} has no debugpy — pip install debugpy`)
  process.exit(0)
}

/** Buffer session events so a `stopped` that fires before we await is not lost. */
function collector(session) {
  const seen = []
  const waiters = []
  for (const name of ['stopped', 'continued', 'terminated', 'exited', 'output', 'error', 'started']) {
    session.on(name, (payload) => {
      const entry = { name, payload }
      seen.push(entry)
      for (const waiter of waiters.slice()) {
        if (waiter.name === name && waiter.predicate(payload)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          clearTimeout(waiter.timer)
          waiter.resolve(payload)
        }
      }
    })
  }
  return {
    seen,
    wait(name, predicate = () => true, ms = 30000) {
      const hit = seen.find((entry) => entry.name === name && predicate(entry.payload))
      if (hit) return Promise.resolve(hit.payload)
      return new Promise((resolve, reject) => {
        const waiter = { name, predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`timeout waiting for ${name}; saw ${seen.map((e) => e.name).join(',')}`))
        }, ms)
        waiters.push(waiter)
      })
    },
    text() {
      return seen.filter((e) => e.name === 'output').map((e) => e.payload.text).join('')
    },
  }
}

function threadOf(stopped) {
  return stopped.threadId ?? 1
}

// ── 1. breakpoints, stepping, variables, evaluate ───────────────────────
{
  const script = join(dir, 'loop.py')
  writeFileSync(
    script,
    [
      'def area(w, h):',
      '    return w * h',
      '',
      'def main():',
      '    total = 0',
      '    for i in range(3):',
      '        total += area(i + 2, 3)',
      '    print("total", total)',
      '    return total',
      '',
      'main()',
      '',
    ].join('\n'),
    'utf8',
  )

  const session = createDebugSession({ python, cwd: dir, file: script, id: 'dbg-loop' })
  const events = collector(session)
  await session.start({ breakpoints: { [script]: [7] }, exceptionFilters: [] })
  check('start() reports the session as started', events.seen.some((e) => e.name === 'started'), events.seen.map((e) => e.name).join(','))
  check('session status is running after start', session.status === 'running', session.status)

  const stopped = await events.wait('stopped')
  check('breakpoint stops the program', stopped.reason === 'breakpoint', stopped.reason)
  const threadId = threadOf(stopped)

  const stack = await session.command('stackTrace', { threadId, startFrame: 0, levels: 10 })
  const frames = stack.body.stackFrames || []
  check('stack trace has frames', frames.length >= 1, JSON.stringify(stack.body).slice(0, 200))
  check('top frame is inside main()', frames[0]?.name === 'main', frames[0]?.name)
  check('top frame points at the breakpoint line', frames[0]?.line === 7, String(frames[0]?.line))

  const scopes = await session.command('scopes', { frameId: frames[0].id })
  const locals = (scopes.body.scopes || []).find((s) => s.name === 'Locals')
  check('locals scope exists', Boolean(locals), JSON.stringify(scopes.body).slice(0, 200))
  const vars = await session.command('variables', { variablesReference: locals.variablesReference })
  const named = (vars.body.variables || []).map((v) => `${v.name}=${v.value}`)
  check('locals expose loop variables', named.some((v) => v.startsWith('i=')) && named.some((v) => v.startsWith('total=')), named.join(','))

  const evaluated = await session.command('evaluate', { expression: 'i + 100', frameId: frames[0].id, context: 'repl' })
  check('evaluate() runs an expression in the frame', evaluated.body.result === '100', JSON.stringify(evaluated.body).slice(0, 200))

  const step = await session.command('next', { threadId })
  check('next is accepted', step.ok === true, step.message)
  const stepped = await events.wait('stopped', (p) => p.reason === 'step')
  check('stepping produces a second stop', stepped.reason === 'step', stepped.reason)

  await session.command('continue', { threadId })
  const second = await events.wait('stopped', (p) => p.stopCount === 2 || p.reason === 'breakpoint')
  check('loop comes back to the same breakpoint', second.reason === 'breakpoint', second.reason)

  await session.setBreakpoints(script, [])
  await session.command('continue', { threadId })
  const terminated = await events.wait('terminated', () => true, 30000)
  check('clearing breakpoints lets the program finish', Boolean(terminated), 'no terminated event')
  check('program output reaches the log', events.text().includes('total 27'), events.text().slice(-200))
  check('session ends terminated', session.status === 'terminated', session.status)
  await session.stop()
}

// ── 2. uncaught exception stops the debugger ────────────────────────────
{
  const script = join(dir, 'boom.py')
  writeFileSync(script, ['def explode():', '    raise ValueError("boom 中文")', '', 'explode()', ''].join('\n'), 'utf8')
  const session = createDebugSession({ python, cwd: dir, file: script, id: 'dbg-boom' })
  const events = collector(session)
  await session.start({ breakpoints: {}, exceptionFilters: ['uncaught'] })
  const stopped = await events.wait('stopped', () => true, 30000)
  check('exception stops the debugger', stopped.reason === 'exception', stopped.reason)
  check('exception carries a description', typeof stopped.description === 'string' && stopped.description.length > 0, JSON.stringify(stopped).slice(0, 200))
  const stack = await session.command('stackTrace', { threadId: threadOf(stopped), startFrame: 0, levels: 5 })
  check('exception stack points at explode()', stack.body.stackFrames?.[0]?.name === 'explode', JSON.stringify(stack.body.stackFrames?.[0] || {}).slice(0, 200))
  await session.stop()
}

// ── 3. stop() kills a program stuck in a loop ───────────────────────────
{
  const script = join(dir, 'sleepy.py')
  writeFileSync(script, 'import time\nprint("started")\ntime.sleep(120)\nprint("never")\n', 'utf8')
  const session = createDebugSession({ python, cwd: dir, file: script, id: 'dbg-stop' })
  const events = collector(session)
  await session.start({ breakpoints: {}, exceptionFilters: [] })
  await events.wait('output', (p) => p.text.includes('started'), 30000)
  await session.stop()
  const terminated = await events.wait('terminated', () => true, 15000)
  check('stop() ends the debug session', Boolean(terminated), 'no terminated event')
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
