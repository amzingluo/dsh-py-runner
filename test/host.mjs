/**
 * Host-layer test for lib/index.js — run with:
 *   node dsh-py-runner/test/host.mjs
 *
 * Mounts the plugin against a fake cordis context whose `webServer.register`
 * collects routes, then exercises those routes over real HTTP (JSON + SSE), so
 * the same code path the GUI uses is covered without launching DSH.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workspace = mkdtempSync(join(tmpdir(), 'py-runner-host-'))
writeFileSync(join(workspace, 'calc.py'), 'print(2 + 3)\n', 'utf8')
writeFileSync(join(workspace, 'reads_input.py'), 'name = input("name? ")\nprint("hi", name)\n', 'utf8')
writeFileSync(join(workspace, 'notes.txt'), 'not python\n', 'utf8')

const { apply, API_PREFIX } = await import('../lib/index.js')

// ── fake host context ───────────────────────────────────────────────────
const routes = []
const services = {
  webServer: {
    protocol: 'http:',
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}
const ctx = {
  inject(names, callback) {
    const scoped = { ...ctx }
    for (const name of names) scoped[name] = services[name]
    callback(scoped)
  },
  effect(fn) {
    return fn()
  },
  get(name) {
    return services[name]
  },
  sessions: { get: () => undefined },
}

apply(ctx, {})
if (routes.length !== 1) throw new Error(`expected 1 route, got ${routes.length}`)
if (routes[0].kind !== 'prefix' || routes[0].path !== API_PREFIX) {
  throw new Error(`unexpected route: ${JSON.stringify(routes[0])}`)
}

const server = createServer((request, response) => routes[0].handler(request, response))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// ── helpers ─────────────────────────────────────────────────────────────
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`)
}

async function post(method, payload) {
  const response = await fetch(`${origin}${API_PREFIX}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

async function getRaw(method, query = '') {
  const response = await fetch(`${origin}${API_PREFIX}/${method}${query}`)
  return { status: response.status, body: await response.text() }
}

function readStream(response, untilText, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('sse timeout; saw:\n' + text)), timeoutMs)
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          clearTimeout(timer)
          resolve(text)
          return
        }
        text += decoder.decode(value, { stream: true })
        if (text.includes(untilText)) {
          clearTimeout(timer)
          await reader.cancel().catch(() => {})
          resolve(text)
          return
        }
      }
    }
    pump().catch((error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// ── info ────────────────────────────────────────────────────────────────
{
  const result = await post('info', { cwd: workspace })
  check('info succeeds', result.body.ok === true, JSON.stringify(result.body).slice(0, 200))
  const info = result.body.result || {}
  check('info echoes the workspace', info.cwd === workspace, info.cwd)
  check('info finds .py files only', info.files.some((f) => f.path === 'calc.py') && !info.files.some((f) => f.path === 'notes.txt'), JSON.stringify(info.files))
  check('info discovers a real interpreter', info.interpreters.length > 0, JSON.stringify(info.interpreters))
}

// ── read ────────────────────────────────────────────────────────────────
{
  const ok = await post('read', { cwd: workspace, path: 'calc.py' })
  check('read returns content', ok.body.ok === true && ok.body.result.content.includes('2 + 3'), JSON.stringify(ok.body).slice(0, 200))

  const escape = await post('read', { cwd: workspace, path: '..\\..\\windows\\win.ini' })
  check('read refuses paths outside the workspace', escape.body.ok === false && /不在工作区/.test(escape.body.error), JSON.stringify(escape.body))

  const missing = await post('read', { cwd: workspace, path: 'nope.py' })
  check('read reports a missing file', missing.body.ok === false, JSON.stringify(missing.body))
}

// ── save ────────────────────────────────────────────────────────────────
{
  const saved = await post('save', { cwd: workspace, path: 'calc.py', content: 'print(6 * 7)\n' })
  check('save writes the file', saved.body.ok === true, JSON.stringify(saved.body))
  check('save hits the disk', readFileSync(join(workspace, 'calc.py'), 'utf8') === 'print(6 * 7)\n', 'disk unchanged')
}

// ── encoding ────────────────────────────────────────────────────────────
{
  // "# 中文" written as GBK bytes: these scripts predate UTF-8 here.
  const gbk = Buffer.concat([
    Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]),
    Buffer.from('print(1)\n', 'ascii'),
  ])
  writeFileSync(join(workspace, 'gbk.py'), gbk)

  const read = await post('read', { cwd: workspace, path: 'gbk.py' })
  const body = read.body.result || {}
  check('read decodes GBK', read.body.ok === true && body.encoding === 'gbk', JSON.stringify(read.body).slice(0, 200))
  check('read keeps the Chinese comment', body.content.includes('中文'), JSON.stringify(body.content))

  const refused = await post('save', { cwd: workspace, path: 'gbk.py', content: '# 中文\nprint(2)\n' })
  check('save refuses to rewrite a GBK file', refused.body.ok === false && /GBK/.test(refused.body.error), JSON.stringify(refused.body))
  check('save left the GBK file untouched', readFileSync(join(workspace, 'gbk.py')).equals(gbk), 'file changed')

  const utf8 = await post('read', { cwd: workspace, path: 'calc.py' })
  check('read reports UTF-8 for normal files', (utf8.body.result || {}).encoding === 'utf-8', JSON.stringify(utf8.body).slice(0, 160))
}

// ── run + SSE ───────────────────────────────────────────────────────────
{
  const started = await post('run', { cwd: workspace, path: 'calc.py', mode: 'run' })
  check('run starts a process', started.body.ok === true && typeof started.body.result.id === 'string', JSON.stringify(started.body))
  const id = started.body.result.id

  const stream = await fetch(`${origin}${API_PREFIX}/events?id=${id}&from=0`)
  check('events stream opens', stream.status === 200 && (stream.headers.get('content-type') || '').includes('text/event-stream'), String(stream.status))
  const text = await readStream(stream, '"type":"exit"')
  check('events carry stdout', text.includes('42'), text.slice(0, 300))
  check('events announce the exit', text.includes('"type":"exit"'), text.slice(-200))
}

// ── run with stdin ──────────────────────────────────────────────────────
{
  const started = await post('run', { cwd: workspace, path: 'reads_input.py', mode: 'run' })
  const id = started.body.result.id
  const stream = await fetch(`${origin}${API_PREFIX}/events?id=${id}&from=0`)
  setTimeout(async () => {
    await post('stdin', { id, text: 'Ada\n' })
  }, 1200)
  const text = await readStream(stream, '"type":"exit"', 20000)
  check('stdin reaches the program', text.includes('hi Ada'), text.slice(0, 400))
}

// ── replay from a middle sequence ───────────────────────────────────────
{
  const started = await post('run', { cwd: workspace, path: 'calc.py', mode: 'run' })
  const id = started.body.result.id
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const replay = await fetch(`${origin}${API_PREFIX}/events?id=${id}&from=0`)
  const text = await readStream(replay, '"type":"exit"', 10000)
  check('finished run replays and closes', text.includes('42'), text.slice(0, 300))
}

// ── error handling ──────────────────────────────────────────────────────
{
  const missing = await post('run', { cwd: workspace, path: 'nope.py' })
  check('run rejects a missing file', missing.body.ok === false, JSON.stringify(missing.body))

  const unknown = await post('nonsense', {})
  check('unknown method is 404', unknown.status === 404, String(unknown.status))

  const wrongVerb = await getRaw('info')
  check('GET on a POST method is 405', wrongVerb.status === 405, String(wrongVerb.status))

  const badEvents = await getRaw('events', '?id=deadbeef&from=0')
  check('events on an unknown run reports an error', badEvents.body.includes('找不到'), badEvents.body.slice(0, 200))

  const outside = await post('run', { cwd: workspace, path: 'C:\\Windows\\notepad.exe' })
  check('run refuses paths outside the workspace', outside.body.ok === false, JSON.stringify(outside.body))
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
server.close()
process.exit(failed.length === 0 ? 0 : 1)
