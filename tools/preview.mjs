// Renders static HTML mocks of the panel using the real stylesheet from
// lib/client.js, so the look can be reviewed (and screenshotted) without
// booting DSH. Markup mirrors the DOM Workbench produces, in both states:
// idle run console and paused debug session.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// Pull the joined CSS array out of the module without booting it.
const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'
const start = source.indexOf('var CSS = [')
const end = source.indexOf("].join('\\n')", start)
if (start < 0 || end < 0) throw new Error('CSS array not found in lib/client.js')
const css = new Function('MONO', source.slice(start, end + 1) + '\nreturn CSS')(MONO)
  .join('\n')

const LIGHT = `
  --dsw-alias-label-primary:#1f2328; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-bg-layer-1:#f7f8fa; --dsw-alias-bg-layer-2:rgba(15,23,42,.07); --dsw-alias-bg-layer-3:rgba(15,23,42,.13);
  --dsw-alias-border-l1:rgba(15,23,42,.14); --dsw-alias-border-l2:rgba(15,23,42,.26);
  --dsw-alias-brand-primary:#2f7cf6;
  --dsw-alias-state-success-primary:#2b8f61; --dsw-alias-state-error-primary:#d93a3f;
  --dsw-alias-state-warn-primary:#c07a00;`

const DARK = `
  --dsw-alias-label-primary:#e7e8ea; --dsw-alias-label-secondary:#9aa0a8;
  --dsw-alias-bg-layer-1:#1b1c20; --dsw-alias-bg-layer-2:rgba(255,255,255,.08); --dsw-alias-bg-layer-3:rgba(255,255,255,.16);
  --dsw-alias-border-l1:rgba(255,255,255,.13); --dsw-alias-border-l2:rgba(255,255,255,.26);
  --dsw-alias-brand-primary:#5c9dff;
  --dsw-alias-state-success-primary:#4ec38a; --dsw-alias-state-error-primary:#ff6b6b;
  --dsw-alias-state-warn-primary:#e0a53a;`

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M5.3 3.1v9.8L13 8z" fill="currentColor"/></svg>',
  bug: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.7a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z" fill="currentColor"/><path d="M6.1 4.3h3.8a1.7 1.7 0 0 1 1.7 1.7v4.2a3.6 3.6 0 1 1-7.2 0V6a1.7 1.7 0 0 1 1.7-1.7z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.7 4.7h6.6v6.6H4.7z" fill="currentColor"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6.6 11.3 3.6 8.3l1.2-1.2 1.8 1.8 4.6-4.6 1.2 1.2z" fill="currentColor"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2.4V4.2a3.8 3.8 0 1 1-3.7 4.6l1.7-.4A2.1 2.1 0 1 0 8 6v1.8l3-2.7z" fill="currentColor"/></svg>',
  continue:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.4 3.1v9.8L11.4 8z" fill="currentColor"/><path d="M11.6 3.1h1.9v9.8h-1.9z" fill="currentColor"/></svg>',
  over: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z" fill="currentColor"/><path d="M7.2 6.4h1.6v5.2h3.1L8 14.2 4.1 11.6h3.1z" fill="currentColor"/></svg>',
  into: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z" fill="currentColor"/><path d="M7.2 6.4h1.6v5.2h3.1L8 14.2 4.1 11.6h3.1z" fill="currentColor"/></svg>',
  out: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z" fill="currentColor"/><path d="M7.2 6.2h1.6v5.4h3.1L8 14.2 4.1 11.6h3.1z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.6 3.3h2.5v9.4H4.6zM8.9 3.3h2.5v9.4H8.9z" fill="currentColor"/></svg>',
}

const CODE = `
<span style="color:#9b5de5">from</span> <span style="color:#1f8a9c">datetime</span> <span style="color:#9b5de5">import</span> datetime
<span style="color:#9b5de5">import</span> sqlite3
<span style="color:#9b5de5">from</span> model_daily_basic <span style="color:#9b5de5">import</span> *
<span style="color:#9b5de5">from</span> util_show <span style="color:#9b5de5">import</span> *
<span style="color:#9b5de5">import</span> pandas <span style="color:#9b5de5">as</span> pd

<span style="color:#7f8794;font-style:italic"># etf 抄底研究：把每日收盘价和资金流拼到一起</span>
<span style="color:#2f6fb0">engine_ts</span> = <span style="color:#2f6fb0">create_engine</span>(<span style="color:#2f9e6f">'mysql+pymysql://user:pw@host/quant'</span>)


<span style="color:#9b5de5">def</span> <span style="color:#2f6fb0">list_etf</span>(<span style="color:#1f8a9c">symbols</span>, <span style="color:#1f8a9c">days</span>=<span style="color:#b5741e">60</span>):
    <span style="color:#7f8794;font-style:italic"># 返回最近 N 天的收盘价</span>
    sql = <span style="color:#2f9e6f">"""SELECT * FROM etf_basic WHERE code IN ({})"""</span>
    df = pd.<span style="color:#2f6fb0">read_sql_query</span>(sql, engine_ts)
    <span style="color:#9b5de5">if</span> df.<span style="color:#2f6fb0">empty</span>:
        <span style="color:#9b5de5">raise</span> <span style="color:#1f8a9c">ValueError</span>(<span style="color:#2f9e6f">f"no rows for {symbols}"</span>)
    <span style="color:#9b5de5">return</span> df.<span style="color:#2f6fb0">tail</span>(days)
`

const GUTTER = (count, { bp = [], cur = 0 } = {}) => {
  const rows = []
  for (let line = 1; line <= count; line += 1) {
    const cls = ['pyr-ln']
    if (bp.includes(line)) cls.push('is-bp')
    if (line === cur) cls.push('is-cur')
    rows.push(`<div class="${cls.join(' ')}"><span class="pyr-ln-num">${line}</span></div>`)
  }
  return rows.join('')
}

const EDITOR = (opts) => `
<div style="flex:1 1 auto;min-height:0;display:flex;overflow:hidden">
  <div class="pyr-gutter-clip" style="min-width:41px">
    <div class="pyr-gutter" style="padding:10px 0 24px">${GUTTER(17, opts)}</div>
  </div>
  <div style="flex:1 1 auto;position:relative;display:flex;overflow:hidden">
    ${opts.cur ? `<div class="pyr-cur" style="top:${10 + (opts.cur - 1) * 19}px"></div>` : ''}
    <pre style="flex:1 1 auto;margin:0;padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:19px;white-space:pre;overflow:hidden">${CODE}</pre>
  </div>
</div>`

const BAR = (right, { pill, time = '', stopDisabled = false, runDisabled = false, debugDisabled = false }) => `
    <div class="pyr-bar">
      <div class="pyr-title">
        <span class="pyr-dot"></span>
        <span class="pyr-name">main_etf_down.py</span>
        <span class="pyr-tag">未保存</span>
      </div>
      <select class="pyr-select"><option>Miniconda3 3.13.2</option></select>
      <span class="pyr-spacer"></span>
      <span class="pyr-pill ${right}"><i></i>${pill}</span>
      ${time ? `<span class="pyr-time">${time}</span>` : ''}
      <button class="pyr-btn pyr-primary"${runDisabled ? ' disabled' : ''}>${ICON.play}运行</button>
      <button class="pyr-btn"${debugDisabled ? ' disabled' : ''}>${ICON.bug}调试</button>
      <button class="pyr-btn pyr-danger"${stopDisabled ? ' disabled' : ''}>${ICON.stop}停止</button>
      <button class="pyr-btn pyr-ghost">${ICON.check}保存</button>
      <button class="pyr-btn pyr-ghost pyr-btn-icon" title="刷新">${ICON.refresh}</button>
    </div>`

const LOG_RUN = `<span>python -u main_etf_down.py</span>
<span style="color:#2f9e6f">[12:04:31] loading etf_basic ... 1284 rows</span>
<span style="color:#2f9e6f">[12:04:33] loading etf_daily ... 512880 rows</span>
<span style="color:#d93a3f">Traceback (most recent call last):</span>
<span style="color:#d93a3f">  File "main_etf_down.py", line 27, in list_etf</span>
<span style="color:#d93a3f">    df = pd.read_sql_query(sql, engine_ts)</span>
<span style="color:#d93a3f">ModuleNotFoundError: No module named 'sqlalchemy'</span>`

const LOG_DEBUG = `<span style="color:#8b93a1">python -Xfrozen_modules=off -m debugpy.adapter</span>
<span>python -u main_etf_down.py</span>
<span style="color:#2f9e6f">[12:04:31] loading etf_basic ... 1284 rows</span>
<span style="color:#8b93a1">断点命中：main_etf_down.py:7</span>
<span style="color:#2f9e6f">[12:04:33] loading etf_daily ... 512880 rows</span>
<span style="color:#8b93a1">单步：main_etf_down.py:12</span>`

const ASIDE = `
      <div class="pyr-aside">
        <div class="pyr-sec">
          <h4>调用栈</h4>
          <div class="pyr-sec-body">
            <button class="pyr-frame is-active" title="C:\\Users\\17871\\Documents\\Obsidian Vault\\probability\\main_etf_down.py"><span class="pyr-where">list_etf  main_etf_down.py</span><span class="pyr-line">:12</span></button>
            <button class="pyr-frame" title="C:\\Users\\17871\\Documents\\Obsidian Vault\\probability\\main_etf_down.py"><span class="pyr-where">main  main_etf_down.py</span><span class="pyr-line">:31</span></button>
            <button class="pyr-frame" title="C:\\Users\\17871\\Documents\\Obsidian Vault\\probability\\main.py"><span class="pyr-where">&lt;module&gt;  main.py</span><span class="pyr-line">:9</span></button>
          </div>
        </div>
        <div class="pyr-sec">
          <h4>变量</h4>
          <div class="pyr-sec-body">
            <div class="pyr-sec-empty">Locals</div>
            <div class="pyr-var is-ref"><span class="pyr-k">▾ symbols</span><span class="pyr-v">['510300', '510500', '159915', '512100']</span><span class="pyr-t">list</span></div>
            <div class="pyr-var" style="padding-left:20px"><span class="pyr-k"></span><span class="pyr-k">0</span><span class="pyr-v">'510300'</span><span class="pyr-t">str</span></div>
            <div class="pyr-var" style="padding-left:20px"><span class="pyr-k"></span><span class="pyr-k">1</span><span class="pyr-v">'510500'</span><span class="pyr-t">str</span></div>
            <div class="pyr-var is-ref"><span class="pyr-k">▸ df</span><span class="pyr-v">shape=(1284, 9)</span><span class="pyr-t">DataFrame</span></div>
            <div class="pyr-var"><span class="pyr-k">days</span><span class="pyr-v">60</span><span class="pyr-t">int</span></div>
            <div class="pyr-var"><span class="pyr-k">sql</span><span class="pyr-v">'SELECT * FROM etf_basic WHERE …'</span><span class="pyr-t">str</span></div>
          </div>
        </div>
        <div class="pyr-sec">
          <h4>监视</h4>
          <div class="pyr-watch"><input placeholder="表达式，回车添加" value="len(df)"></div>
          <div class="pyr-sec-body">
            <div class="pyr-var"><span class="pyr-k">× len(df)</span><span class="pyr-v">1284</span></div>
            <div class="pyr-var is-error"><span class="pyr-k">× df.missing_col</span><span class="pyr-v">AttributeError: 'DataFrame' object has no attribute 'missing_col'</span></div>
          </div>
        </div>
      </div>`

const PAGE = (theme, vars, body) => `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:${theme === 'dark' ? '#141518' : '#ffffff'}}
  body{display:flex}
  :root{${vars}}
  ${css}
  .stage{flex:1;display:flex;flex-direction:column;padding:0}
</style>
<div class="stage">
  <div class="pyr">
${body}
  </div>
</div>`

const RUN_BODY = `${BAR('is-ok', { pill: '已完成', time: '1.24 s', stopDisabled: true })}
    <div class="pyr-main">
      <div class="pyr-upper">
        <div class="pyr-edit">${EDITOR({})}</div>
      </div>
      <div class="pyr-logbar">
        <span>运行日志</span>
        <span class="pyr-file">main_etf_down.py</span>
        <span class="pyr-spacer"></span>
        <span class="pyr-file">python.exe</span>
        <button class="pyr-btn pyr-ghost">清空</button>
        <button class="pyr-btn pyr-ghost">复制</button>
      </div>
      <div class="pyr-log">${LOG_RUN}</div>
      <div class="pyr-stdin"><span class="pyr-stdin-tag">stdin</span><input placeholder="输入一行文本后回车，发送到程序的标准输入"></div>
    </div>`

const DEBUG_BODY = `${BAR('is-error', { pill: '已暂停（异常）', runDisabled: true, debugDisabled: true })}
    <div class="pyr-debugbar">
      <button class="pyr-btn pyr-primary">${ICON.continue}继续</button>
      <button class="pyr-btn pyr-ghost">${ICON.over}单步跳过</button>
      <button class="pyr-btn pyr-ghost">${ICON.into}单步进入</button>
      <button class="pyr-btn pyr-ghost">${ICON.out}单步跳出</button>
      <button class="pyr-btn pyr-ghost" disabled>${ICON.pause}暂停</button>
      <span class="pyr-spacer"></span>
      <span class="pyr-why" title="ValueError: no rows for ['510300']">ValueError: no rows for ['510300']</span>
      <button class="pyr-btn pyr-danger">${ICON.stop}结束</button>
    </div>
    <div class="pyr-main">
      <div class="pyr-upper">
        <div class="pyr-edit">${EDITOR({ bp: [7], cur: 12 })}</div>${ASIDE}
      </div>
      <div class="pyr-logbar">
        <span>运行日志</span>
        <span class="pyr-file">main_etf_down.py</span>
        <span class="pyr-spacer"></span>
        <span class="pyr-file">python.exe</span>
        <button class="pyr-btn pyr-ghost">清空</button>
        <button class="pyr-btn pyr-ghost">复制</button>
      </div>
      <div class="pyr-log">${LOG_DEBUG}</div>
    </div>`

const out = join(root, '.preview')
mkdirSync(out, { recursive: true })

const pages = [
  ['ui-light.html', 'light', LIGHT, RUN_BODY],
  ['ui-dark.html', 'dark', DARK, RUN_BODY],
  ['ui-debug-light.html', 'light', LIGHT, DEBUG_BODY],
  ['ui-debug-dark.html', 'dark', DARK, DEBUG_BODY],
]
for (const [name, theme, vars, body] of pages) {
  writeFileSync(join(out, name), PAGE(theme, vars, body), 'utf8')
  console.log('wrote', join(out, name))
}
