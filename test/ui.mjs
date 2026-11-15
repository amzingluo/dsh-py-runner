// Renders the panel with a stub React and checks the structure the stylesheet
// relies on: class names, button variants, status pill, empty state, and the
// <style> tag injection.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let moduleExports = null
const appended = []

const React = {
  createElement: function (tag, props, ...children) {
    if (typeof tag === 'function') return { component: tag, props: props || {} }
    return { tag: tag, props: props || {}, children: children.flat(Infinity) }
  },
  useState: function (value) {
    return [typeof value === 'function' ? value() : value, function () {}]
  },
  useRef: function (value) {
    return { current: value === undefined ? null : value }
  },
  useEffect: function () {},
  useMemo: function (factory) {
    return factory()
  },
  useCallback: function (fn) {
    return fn
  },
}

const documentStub = {
  baseURI: 'http://127.0.0.1/',
  getElementById: function () {
    return null
  },
  createElement: function (tag) {
    return { tagName: tag, id: '', textContent: '' }
  },
  head: { appendChild: (node) => appended.push(node) },
}

const sandbox = {
  __ModuleLoader__: {
    load: function (definition) {
      moduleExports = definition.factory(function (id) {
        if (id === 'react') return React
        throw new Error('unexpected require: ' + id)
      })
    },
  },
  document: documentStub,
  localStorage: { getItem: () => null, setItem: () => {} },
  EventSource: function () {},
  fetch: () => Promise.resolve({}),
  URL: URL,
  navigator: {},
}

const fn = new Function('window', 'document', 'localStorage', 'EventSource', 'fetch', 'URL', 'navigator', source)
fn(sandbox, sandbox.document, sandbox.localStorage, sandbox.EventSource, sandbox.fetch, URL, sandbox.navigator)

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('ok   ' + name)
  } else {
    failed += 1
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail))
  }
}

// ── registration ─────────────────────────────────────────────────────────
const tabs = []
const viewers = []
const ctx = {
  betterSidebar: {
    registerTab: (descriptor) => (tabs.push(descriptor), () => {}),
    registerFileViewer: (descriptor) => (viewers.push(descriptor), () => {}),
  },
  effect: (fn) => fn(),
}

moduleExports.apply(ctx)

check('registers one tab', tabs.length === 1, String(tabs.length))
check('registers one file viewer', viewers.length === 1, String(viewers.length))
check('tab id', tabs[0] && tabs[0].id === 'py-runner', tabs[0] && tabs[0].id)
check('tab is single', tabs[0] && tabs[0].single === true)
check('viewer claims .py', viewers[0] && viewers[0].exts.join() === 'py')
check('viewer outranks the generic code viewer', viewers[0] && viewers[0].priority === 50)
check('viewer reads through its own API', viewers[0] && viewers[0].fetchStrategy === 'none')

// ── stylesheet ───────────────────────────────────────────────────────────
const styleNode = appended.find((node) => node.tagName === 'style')
check('injects one <style> tag', appended.length === 1, String(appended.length))
check('style tag is identifiable', styleNode && styleNode.id === 'dsh-py-runner-styles')
const css = (styleNode && styleNode.textContent) || ''
for (const selector of ['.pyr-bar', '.pyr-btn', '.pyr-primary', '.pyr-pill', '.pyr-log', '.pyr-stdin', '.pyr-empty', '.pyr-note']) {
  check('stylesheet defines ' + selector, css.includes(selector + '{') || css.includes(selector + ' '), css.length + ' chars')
}
check('stylesheet has hover states', css.includes(':hover'))

// ── render ───────────────────────────────────────────────────────────────
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out))
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node.component !== undefined) {
    flatten(node.component(node.props), out)
    return out
  }
  out.push(node)
  if (node.children) flatten(node.children, out)
  return out
}

function nodesOf(tree, predicate) {
  return flatten(tree).filter((node) => typeof node === 'object' && predicate(node))
}

function textOf(tree) {
  return flatten(tree)
    .filter((node) => typeof node === 'string')
    .join('')
}

const renderTab = () => tabs[0].component({ scope: { sessionId: 's1', cwd: 'C:\\ws' }, visible: true })
const tree = renderTab()

check('renders a root .pyr container', nodesOf(tree, (n) => n.props.className === 'pyr').length === 1)
check('renders a toolbar', nodesOf(tree, (n) => n.props.className === 'pyr-bar').length === 1)

const bar = nodesOf(tree, (n) => n.props.className === 'pyr-bar')[0]
const buttons = flatten(bar.children).filter((n) => typeof n === 'object' && n.tag === 'button')
check('renders five toolbar buttons', buttons.length === 5, String(buttons.length))
check(
  'run button is the filled primary',
  buttons[0].props.className.includes('pyr-primary'),
  buttons[0].props.className,
)
check(
  'stop button is disabled while idle',
  buttons[2].props.disabled === true,
)
check(
  'refresh button is icon-only',
  buttons[4].props.className.includes('pyr-btn-icon'),
  buttons[4].props.className,
)

const pills = nodesOf(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('pyr-pill'))
check('renders one status pill', pills.length === 1, String(pills.length))
check('idle pill says 空闲', textOf(pills[0]) === '空闲', textOf(pills[0]))

const empty = nodesOf(tree, (n) => n.props.className === 'pyr-empty')
check('shows the empty state before a file is opened', empty.length === 1)
check('empty state explains the shortcuts', textOf(empty[0]).includes('Ctrl+Enter'), textOf(empty[0]))

// A viewer render takes the same path but with a file: no file picker in the bar.
const viewerTree = viewers[0].component({ scope: { sessionId: 's1' }, path: 'C:\\ws\\demo.py', visible: true })
const selects = nodesOf(viewerTree, (n) => n.tag === 'select')
check('viewer mode hides the file picker', selects.length === 1, String(selects.length))
const viewerTitle = nodesOf(viewerTree, (n) => n.props.className === 'pyr-title')[0]
check('viewer mode keeps the title block', viewerTitle !== undefined)
check('viewer mode shows a fallback name until the file loads', textOf(viewerTitle).includes('Python 运行器'), textOf(viewerTitle))

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
