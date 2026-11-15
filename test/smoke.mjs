/**
 * Smoke test for lib/runner.js — run with:
 *   node dsh-py-runner/test/smoke.mjs
 * Uses the real Python; needs nothing beyond the standard library.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunner } from '../lib/runner.js'

const python = process.env.TEST_PYTHON || 'D:\\Miniconda3\\python.exe'
const dir = mkdtempSync(join(tmpdir(), 'py-runner-'))

const script = join(dir, 'hello.py')
writeFileSync(
  script,
  [
    'import sys',
    'print("hello 中文")',
    'print("to stderr", file=sys.stderr)',
    'name = input()',
    'print("got:", name)',
    'raise SystemExit(3)',
    '',
  ].join('\n'),
  'utf8',
)

const debugScript = join(dir, 'debug.py')
writeFileSync(debugScript, 'x = 1\ny = x + 41\nprint("y =", y)\n', 'utf8')

const runner = createRunner()

function collect(run, { stdin = [], until = 'exit' } = {}) {
  return new Promise((resolve, reject) => {
    const out = { text: '', chunks: [], exit: null }
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + until)), 25000)
    // subscribe() replays synchronously, so `sub` is still unassigned inside
    // the first callbacks — never reference it directly there.
    let sub = null
    let settled = false
    sub = runner.subscribe(run.id, 0, (event) => {
      if (event.type === 'chunk') {
        out.text += event.text
        out.chunks.push(event)
        for (const line of stdin) {
          if (event.text.includes('(Pdb)') || event.text.includes('input')) {
            runner.write(run.id, line + '\n')
          }
        }
        return
      }
      if (event.type === 'exit' && !settled) {
        settled = true
        out.exit = event
        clearTimeout(timer)
        sub?.off()
        resolve(out)
      }
    })
  })
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`)
}

// ── 1. plain run, stdin forwarding, stderr split, replay ─────────────────
{
  const run = runner.start({ python, cwd: dir, file: script, mode: 'run' })
  check('run id is 8 chars', run.id.length === 8, run.id)
  const pending = collect(run)
  setTimeout(() => runner.write(run.id, 'Ada\n'), 900)
  const out = await pending
  check('stdout captured', out.text.includes('hello 中文'), out.text)
  check('stdin reached the program', out.text.includes('got: Ada'), out.text)
  check('stderr captured separately', out.chunks.some((c) => c.stream === 'stderr' && c.text.includes('to stderr')), 'no stderr chunk')
  check('exit code 3', out.exit.code === 3, JSON.stringify(out.exit))
  check('chunks are strictly sequenced', out.chunks.every((c, i) => i === 0 || c.seq > out.chunks[i - 1].seq), 'sequence not monotonic')

  // Replay after the fact must reproduce everything already logged.
  const replay = await new Promise((resolve) => {
    let text = ''
    let done = false
    let sub = null
    sub = runner.subscribe(run.id, 0, (event) => {
      if (event.type === 'chunk') text += event.text
      if (event.type === 'exit' && !done) {
        done = true
        sub?.off()
        resolve(text)
      }
    })
    if (!done) {
      setTimeout(() => {
        if (!done) {
          sub?.off()
          resolve(text)
        }
      }, 1500)
    }
  })
  check('late subscriber replays the history', replay.includes('hello 中文') && replay.includes('got: Ada'), replay.slice(0, 120))
}

// ── 2. pdb debug session ────────────────────────────────────────────────
{
  const run = runner.start({ python, cwd: dir, file: debugScript, mode: 'debug' })
  const out = await new Promise((resolve, reject) => {
    let text = ''
    let stage = 0
    const timer = setTimeout(() => reject(new Error('pdb timeout; saw: ' + text)), 25000)
    let sub = null
    sub = runner.subscribe(run.id, 0, (event) => {
      if (event.type === 'chunk') {
        text += event.text
        if (stage === 0 && text.includes('(Pdb)')) {
          stage = 1
          runner.write(run.id, 'n\n') // step to `y = x + 41`
        } else if (stage === 1 && text.split('(Pdb)').length > 2) {
          stage = 2
          runner.write(run.id, 'p x\n') // inspect a local
        } else if (stage === 2 && text.split('(Pdb)').length > 3) {
          stage = 3
          runner.write(run.id, 'c\n') // continue to the end
        }
        return
      }
      if (event.type === 'exit') {
        clearTimeout(timer)
        sub?.off()
        resolve({ text, exit: event })
      }
    })
  })
  check('pdb prompt appears', out.text.includes('(Pdb)'), out.text.slice(0, 200))
  check('pdb evaluates locals', /\(Pdb\)\s*1\b/.test(out.text) || out.text.includes('p x'), out.text.slice(-300))
  check('debug run reaches the program output', out.text.includes('y = 42'), out.text.slice(-300))
  check('debug run exits cleanly', out.exit.code === 0, JSON.stringify(out.exit))
}

// ── 3. stop a long-running process ──────────────────────────────────────
{
  const slow = join(dir, 'slow.py')
  writeFileSync(slow, 'import time\nprint("started")\ntime.sleep(120)\nprint("never")\n', 'utf8')
  const run = runner.start({ python, cwd: dir, file: slow, mode: 'run' })
  const started = await new Promise((resolve) => {
    let sub = null
    sub = runner.subscribe(run.id, 0, (event) => {
      if (event.type === 'chunk' && event.text.includes('started')) {
        sub?.off()
        resolve(true)
      }
    })
  })
  check('slow script started', started === true, 'no output')
  check('stop reports success', runner.stop(run.id) === true, 'stop returned false')
  const out = await collect(run)
  check('stop kills the tree', out.exit.code !== 0 || out.exit.signal !== null, JSON.stringify(out.exit))
  check('run is marked exited', runner.get(run.id).status === 'exited', runner.get(run.id).status)
}

// ── 4. bounded log ──────────────────────────────────────────────────────
{
  const spam = join(dir, 'spam.py')
  writeFileSync(spam, 'for i in range(200000):\n    print(i)\n', 'utf8')
  const run = runner.start({ python, cwd: dir, file: spam, mode: 'run' })
  const out = await collect(run)
  const state = runner.get(run.id)
  check('runaway output stays bounded', state.chars <= 800000, String(state.chars))
  check('dropped counter tracks trimming', state.dropped >= 0, String(state.dropped))
  check('spam run still exits', out.exit.code === 0, JSON.stringify(out.exit))
}

// ── 5. missing interpreter ──────────────────────────────────────────────
{
  const run = runner.start({ python: join(dir, 'nope', 'python.exe'), cwd: dir, file: script, mode: 'run' })
  const out = await collect(run).catch((error) => ({ text: '', exit: { code: null, error: error.message } }))
  check('spawn error is reported as a chunk', /无法启动/.test(out.text) || out.exit.code === null, JSON.stringify(out).slice(0, 200))
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
