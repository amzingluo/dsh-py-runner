// Renders a static HTML mock of the panel using the real stylesheet from
// lib/client.js, so the look can be reviewed (and screenshotted) without
// booting DSH. Markup mirrors the DOM Workbench produces.
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
  --dsw-alias-state-success-primary:#2b8f61; --dsw-alias-state-error-primary:#d93a3f;`

const DARK = `
  --dsw-alias-label-primary:#e7e8ea; --dsw-alias-label-secondary:#9aa0a8;
  --dsw-alias-bg-layer-1:#1b1c20; --dsw-alias-bg-layer-2:rgba(255,255,255,.08); --dsw-alias-bg-layer-3:rgba(255,255,255,.16);
  --dsw-alias-border-l1:rgba(255,255,255,.13); --dsw-alias-border-l2:rgba(255,255,255,.26);
  --dsw-alias-brand-primary:#5c9dff;
  --dsw-alias-state-success-primary:#4ec38a; --dsw-alias-state-error-primary:#ff6b6b;`

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M5.3 3.1v9.8L13 8z" fill="currentColor"/></svg>',
  bug: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.7a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z" fill="currentColor"/><path d="M6.1 4.3h3.8a1.7 1.7 0 0 1 1.7 1.7v4.2a3.6 3.6 0 1 1-7.2 0V6a1.7 1.7 0 0 1 1.7-1.7z" fill="currentColor"/><path d="M3.1 6.1h1.8v1.3H3.1zM11.1 6.1h1.8v1.3h-1.8zM3.5 9.7h1.6V11H3.5zM10.9 9.7h1.6V11h-1.6z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.7 4.7h6.6v6.6H4.7z" fill="currentColor"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6.6 11.3 3.6 8.3l1.2-1.2 1.8 1.8 4.6-4.6 1.2 1.2z" fill="currentColor"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2.4V4.2a3.8 3.8 0 1 1-3.7 4.6l1.7-.4A2.1 2.1 0 1 0 8 6v1.8l3-2.7z" fill="currentColor"/></svg>',
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

const LOG = `<span>python -u main_etf_down.py</span>
<span style="color:#2f9e6f">[12:04:31] loading etf_basic ... 1284 rows</span>
<span style="color:#2f9e6f">[12:04:33] loading etf_daily ... 512880 rows</span>
<span style="color:#d93a3f">Traceback (most recent call last):</span>
<span style="color:#d93a3f">  File "main_etf_down.py", line 27, in list_etf</span>
<span style="color:#d93a3f">    df = pd.read_sql_query(sql, engine_ts)</span>
<span style="color:#d93a3f">ModuleNotFoundError: No module named 'sqlalchemy'</span>`

const PAGE = (theme, vars) => `<!doctype html>
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
    <div class="pyr-bar">
      <div class="pyr-title">
        <span class="pyr-dot"></span>
        <span class="pyr-name">main_etf_down.py</span>
        <span class="pyr-tag">未保存</span>
      </div>
      <select class="pyr-select"><option>Miniconda3 3.13.2</option></select>
      <span class="pyr-spacer"></span>
      <span class="pyr-pill is-ok"><i></i>已完成</span>
      <span class="pyr-time">1.24 s</span>
      <button class="pyr-btn pyr-primary">${ICON.play}运行</button>
      <button class="pyr-btn">${ICON.bug}调试</button>
      <button class="pyr-btn pyr-danger" disabled>${ICON.stop}停止</button>
      <button class="pyr-btn pyr-ghost">${ICON.check}保存</button>
      <button class="pyr-btn pyr-ghost pyr-btn-icon" title="刷新">${ICON.refresh}</button>
    </div>
    <div class="pyr-main">
      <div style="flex:1 1 auto;min-height:120px;display:flex;overflow:hidden">
        <div style="flex:0 0 auto;padding:10px 8px 10px 12px;text-align:right;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:19px;color:#6b7280;white-space:pre;user-select:none;border-right:1px solid rgba(127,127,127,.22);background:var(--dsw-alias-bg-layer-1)">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19</div>
        <pre style="flex:1 1 auto;margin:0;padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:19px;white-space:pre;overflow:hidden">${CODE}</pre>
      </div>
      <div class="pyr-logbar">
        <span>运行日志</span>
        <span class="pyr-file">main_etf_down.py</span>
        <span class="pyr-spacer"></span>
        <span class="pyr-file">python.exe</span>
        <button class="pyr-btn pyr-ghost">清空</button>
        <button class="pyr-btn pyr-ghost">复制</button>
      </div>
      <div class="pyr-log">${LOG}</div>
      <div class="pyr-stdin"><span class="pyr-stdin-tag">stdin</span><input placeholder="输入一行文本后回车，发送到程序的标准输入"></div>
    </div>
  </div>
</div>`

const out = join(root, '.preview')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'ui-light.html'), PAGE('light', LIGHT), 'utf8')
writeFileSync(join(out, 'ui-dark.html'), PAGE('dark', DARK), 'utf8')
console.log('wrote', join(out, 'ui-light.html'))
console.log('wrote', join(out, 'ui-dark.html'))
