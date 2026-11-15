// Smoke test for the client bundle: loads it the way the host module loader
// does, with a stub React, and checks the Python highlighter's token colours.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let moduleExports = null

const React = {
  createElement: function (tag, props, ...children) {
    if (typeof tag === 'function') return { component: tag, props: props }
    return { tag: tag, props: props || {}, children: children.flat() }
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

const sandbox = {
  __ModuleLoader__: {
    load: function (definition) {
      moduleExports = definition.factory(function (id) {
        if (id === 'react') return React
        throw new Error('unexpected require: ' + id)
      })
    },
  },
  document: { baseURI: 'http://127.0.0.1/' },
  localStorage: { getItem: () => null, setItem: () => {} },
  EventSource: function () {},
  fetch: () => Promise.resolve({}),
  URL: URL,
}

const fn = new Function('window', 'document', 'localStorage', 'EventSource', 'fetch', 'URL', source)
fn(sandbox, sandbox.document, sandbox.localStorage, sandbox.EventSource, sandbox.fetch, URL)

const highlight = moduleExports.highlightPython

function flat(nodes) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node === 'string') {
      out.push({ text: node, color: null })
      return
    }
    const color = node.props && node.props.style ? node.props.style.color : null
    for (const child of node.children) {
      if (typeof child === 'string') out.push({ text: child, color })
      else walk(child)
    }
  }
  walk(nodes)
  return out
}

let pass = 0
let fail = 0
function check(name, condition, detail) {
  if (condition) {
    pass += 1
  } else {
    fail += 1
    console.log('FAIL ' + name + (detail === undefined ? '' : ' → ' + detail))
  }
}

const palette = {
  keyword: '#9b5de5',
  string: '#2f9e6f',
  comment: '#7f8794',
  number: '#b5741e',
  decorator: '#8a6d1f',
  func: '#2f6fb0',
  builtin: '#1f8a9c',
}

// Text must survive highlighting byte for byte.
const sample = [
  '#!/usr/bin/env python',
  '#encoding:gbk',
  'from sqlalchemy import create_engine, text',
  '',
  'engine = create_engine("mysql+pymysql://u:p@host/db")',
  '@decorator(arg=1)',
  'def fetch(limit=10):',
  '    """Docstring with # hash and \'quote\'."""',
  "    name = 'value'",
  '    if limit > 0 and name != "":',
  '        return print(f"{name} {limit:.2f}")',
  '    return None',
].join('\n')

check('roundtrip', flat(highlight(sample)).map((n) => n.text).join('') === sample)

const tokens = flat(highlight(sample)).filter((n) => n.color !== null)
const colorOf = (text) => {
  const hit = tokens.filter((n) => n.text === text)
  return hit.length === 0 ? null : hit[hit.length - 1].color
}

check('comment', colorOf('#encoding:gbk') === palette.comment, colorOf('#encoding:gbk'))
check('shebang', colorOf('#!/usr/bin/env python') === palette.comment)
check('keyword import', colorOf('import') === palette.keyword)
check('keyword def', colorOf('def') === palette.keyword)
check('keyword None', colorOf('None') === palette.keyword)
check('builtin print', colorOf('print') === palette.builtin, colorOf('print'))
check('number', colorOf('10') === palette.number, colorOf('10'))
check('decorator', colorOf('@decorator') === palette.decorator, colorOf('@decorator'))
check('function call', colorOf('create_engine') === palette.func, colorOf('create_engine'))
check('string', colorOf("'value'") === palette.string, colorOf("'value'"))
check('triple string', colorOf('"""Docstring with # hash and \'quote\'."""') === palette.string)
check('f-string', colorOf('f"{name} {limit:.2f}"') === palette.string, colorOf('f"{name} {limit:.2f}"'))

// A hash inside a string must not start a comment.
const mixed = flat(highlight('x = "# not a comment"\ny = 1  # real'))
check('hash in string', mixed.filter((n) => n.color === palette.comment).length === 1)
check('hash in string text', mixed.map((n) => n.text).join('') === 'x = "# not a comment"\ny = 1  # real')

// Empty / plain content must not blow up.
check('empty', flat(highlight('')) === undefined || flat(highlight('')).length <= 1)
check('plain', flat(highlight('abc def')).length > 0)

// Oversized files fall back to "no highlighting" (null), the editor then keeps
// the plain textarea.
check('oversize guard', highlight('x'.repeat(200001)) === null)

// Escaped quotes stay inside the string token.
const escaped = flat(highlight('s = "a\\"b" + 1'))
check('escaped quote', escaped.filter((n) => n.color === palette.string).length === 1, JSON.stringify(escaped))

console.log((fail === 0 ? 'ok' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed')
process.exitCode = fail === 0 ? 0 : 1
