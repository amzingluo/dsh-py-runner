/**
 * dsh-py-runner — client half.
 *
 * Hand-written bundle: no JSX, no bundler, no npm. `require()` resolves only
 * the modules the host shares with plugins (react and friends).
 *
 * Registers two better-sidebar extension points:
 *   • a tab        — "Python 运行器", a workbench for any *.py in the workspace
 *   • a file view  — claims `.py`, so simply opening a script gives you the
 *                    Run / Debug buttons and the live log underneath
 *
 * Both render the same Workbench and share one Controller per session, so the
 * log keeps running (and keeps streaming) while you look at something else.
 * Colour comes only from the host's `--dsw-alias-*` tokens, so light and dark
 * themes both work and nothing goes stale on a theme change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-py-runner',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var API_ROOT = '/dsh-py-runner/api/'
    var LS_PYTHON = 'dsh-py-runner:python'
    /** Client-side log ceiling; the host trims sooner. */
    var MAX_LOG_CHARS = 400000
    var MAX_STDIN_HISTORY = 50
    var LS_BREAKPOINTS = 'dsh-py-runner:breakpoints:'
    var LINE_HEIGHT = 19
    var EDITOR_PAD_TOP = 10
    var MAX_GUTTER_LINES = 8000

    // ── palette ──────────────────────────────────────────────────────────
    var C = {
      fg: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,1))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.32))',
      layer1: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.22))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
      brand: 'var(--dsw-alias-brand-primary, #4d9fff)',
      error: 'var(--dsw-alias-state-error-primary, #ff8b8b)',
      success: 'var(--dsw-alias-state-success-primary, #42c07a)',
      idle: 'var(--dsw-alias-state-idle-primary, rgba(127,127,127,1))',
      warn: 'var(--dsw-alias-state-warn-primary, #ffb86b)',
      // Python syntax palette: picked to stay legible on light and dark
      // backgrounds, since the host themes are not known ahead of time.
      synKeyword: '#9b5de5',
      synString: '#2f9e6f',
      synComment: '#7f8794',
      synNumber: '#b5741e',
      synDecorator: '#8a6d1f',
      synFunc: '#2f6fb0',
      synBuiltin: '#1f8a9c',
    }

    // ── style ────────────────────────────────────────────────────────────
    var MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

    // Only the editor needs inline metrics: the highlight layer and the
    // textarea must agree to the pixel. Everything else lives in CSS below.
    var S = {
      editorRow: { flex: '1 1 auto', minHeight: 120, display: 'flex', overflow: 'hidden' },
      gutterText: {
        margin: 0,
        padding: '0 9px 0 12px',
        textAlign: 'right',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: '19px',
        color: C.muted,
        whiteSpace: 'pre',
      },
      codeWrap: {
        position: 'relative',
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      },
      highlight: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        margin: 0,
        padding: '10px 12px',
        border: 'none',
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: '19px',
        whiteSpace: 'pre',
        tabSize: 4,
        overflow: 'hidden',
        pointerEvents: 'none',
        color: C.fg,
      },
      textareaOverlay: {
        position: 'relative',
        zIndex: 1,
        color: 'transparent',
        caretColor: 'var(--dsw-alias-label-primary, #111)',
        background: 'transparent',
      },
      textarea: {
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
        minHeight: 0,
        display: 'block',
        boxSizing: 'border-box',
        resize: 'none',
        border: 'none',
        outline: 'none',
        padding: '10px 12px',
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: '19px',
        color: C.fg,
        background: 'transparent',
        tabSize: 4,
        whiteSpace: 'pre',
        overflow: 'auto',
      },
    }

    var LOG_COLORS = { stdout: 'inherit', stderr: C.error, meta: C.brand }

    // ── stylesheet ───────────────────────────────────────────────────────
    // Inline styles cannot express :hover, :focus-visible or ::-webkit-scrollbar,
    // and a toolbar without those feels dead. One <style> tag, injected once,
    // using the host's alias tokens so both themes keep working.
    var STYLE_ID = 'dsh-py-runner-styles'

    var CSS = [
      '.pyr{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2328);background:transparent}',
      '.pyr *{box-sizing:border-box}',
      '.pyr ::-webkit-scrollbar{width:10px;height:10px}',
      '.pyr ::-webkit-scrollbar-track{background:transparent}',
      '.pyr ::-webkit-scrollbar-thumb{background:rgba(127,127,127,.3);border:3px solid transparent;background-clip:content-box;border-radius:8px}',
      '.pyr ::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5);background-clip:content-box}',

      '.pyr-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;flex:0 0 auto;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.pyr-spacer{flex:1 1 auto}',
      '.pyr-title{display:flex;align-items:center;gap:7px;min-width:0;margin-right:2px;font-size:12.5px;font-weight:600}',
      '.pyr-title .pyr-name{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pyr-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4d9fff);',
      'box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 16%,transparent)}',
      '.pyr-tag{flex:0 0 auto;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:700;letter-spacing:.05em;',
      'text-transform:uppercase;color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',

      '.pyr-btn{height:28px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 11px;',
      'font:inherit;font-size:12px;font-weight:500;line-height:1;color:var(--dsw-alias-label-primary,#1f2328);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));border:1px solid transparent;border-radius:7px;',
      'cursor:pointer;white-space:nowrap;user-select:none;',
      'transition:background .12s ease,border-color .12s ease,color .12s ease,filter .12s ease,transform .06s ease}',
      '.pyr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.2))}',
      '.pyr-btn:active:not(:disabled){transform:translateY(1px)}',
      '.pyr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d9fff);outline-offset:1px}',
      '.pyr-btn:disabled{opacity:.4;cursor:default}',
      '.pyr-btn svg{width:13px;height:13px;flex:0 0 auto}',
      '.pyr-btn-icon{padding:0 7px}',
      '.pyr-primary{background:var(--dsw-alias-brand-primary,#4d9fff);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.16)}',
      '.pyr-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d9fff);filter:brightness(1.07)}',
      '.pyr-danger{background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 40%,transparent)}',
      '.pyr-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent)}',
      '.pyr-ghost{background:transparent}',
      '.pyr-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',

      '.pyr-select{height:28px;max-width:220px;padding:0 26px 0 9px;font:inherit;font-size:12px;border-radius:7px;',
      'color:var(--dsw-alias-label-primary,#1f2328);background-color:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));cursor:pointer;appearance:none;outline:none;',
      'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'><path fill=\'%23848a94\' d=\'M4.2 6.2h7.6L8 10.6z\'/></svg>");',
      'background-repeat:no-repeat;background-position:right 7px center;background-size:11px}',
      '.pyr-select:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.pyr-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d9fff);outline-offset:1px}',

      '.pyr-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;',
      'font-size:11.5px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.pyr-pill i{display:block;width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.pyr-pill.is-run{color:var(--dsw-alias-brand-primary,#4d9fff)}',
      '.pyr-pill.is-ok{color:var(--dsw-alias-state-success-primary,#2f9e6f)}',
      '.pyr-pill.is-error{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.pyr-pill.is-live i{animation:pyr-pulse 1.4s ease-in-out infinite}',
      '@keyframes pyr-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.pyr-time{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}',

      '.pyr-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '.pyr-logbar{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:4px 12px;',
      'font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}',
      '.pyr-logbar .pyr-file{font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;',
      'max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pyr-log{flex:0 0 auto;height:232px;overflow:auto;padding:8px 14px 12px;font-size:12px;line-height:18px;',
      'font-family:' + MONO + ';white-space:pre-wrap;word-break:break-word;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03))}',
      '.pyr-empty-chunk{color:var(--dsw-alias-label-secondary,#6b7280);font-family:inherit}',

      '.pyr-stdin{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 12px;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.pyr-stdin input{flex:1 1 auto;min-width:0;height:28px;padding:0 10px;font:inherit;font-size:12px;border-radius:7px;',
      'font-family:' + MONO + ';color:var(--dsw-alias-label-primary,#1f2328);',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));outline:none}',
      '.pyr-stdin input:focus{border-color:var(--dsw-alias-brand-primary,#4d9fff)}',
      '.pyr-stdin-tag{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;',
      'padding:2px 6px;border-radius:5px;color:var(--dsw-alias-brand-primary,#4d9fff);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 12%,transparent)}',

      '.pyr-note{display:flex;gap:8px;align-items:flex-start;flex:0 0 auto;margin:8px 12px 0;padding:7px 10px;',
      'font-size:12px;line-height:1.5;border-radius:8px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 35%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 8%,transparent);',
      'color:var(--dsw-alias-label-primary,#1f2328)}',
      '.pyr-note.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 40%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 8%,transparent)}',

      '.pyr-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:6px;padding:32px 24px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12.5px;line-height:1.7}',
      '.pyr-empty-badge{display:grid;place-items:center;width:48px;height:48px;margin-bottom:6px;border-radius:14px;',
      'color:var(--dsw-alias-brand-primary,#4d9fff);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 10%,transparent);',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 22%,transparent)}',
      '.pyr-empty strong{color:var(--dsw-alias-label-primary,#1f2328);font-size:13px}',
      '.pyr-kbd{display:inline-block;padding:0 5px;margin:0 1px;border-radius:4px;font-family:' + MONO + ';font-size:11px;',
      'color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',

      // ── debugger chrome ──────────────────────────────────────────────
      '.pyr-upper{display:flex;flex:1 1 auto;min-height:0}',
      '.pyr-edit{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
      '.pyr-aside{flex:0 0 auto;width:296px;max-width:46%;display:flex;flex-direction:column;overflow:auto;',
      'border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03))}',
      '.pyr-sec{flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))}',
      '.pyr-sec h4{margin:0;display:flex;align-items:center;gap:6px;padding:6px 10px 3px;font-size:10.5px;font-weight:700;',
      'letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.pyr-sec-body{padding:0 4px 7px;max-height:230px;overflow-y:auto;overflow-x:hidden}',
      '.pyr-frame{display:flex;align-items:baseline;gap:6px;width:100%;padding:3px 7px;border:none;border-radius:6px;',
      'background:transparent;color:inherit;font:inherit;font-size:11.5px;text-align:left;cursor:pointer}',
      '.pyr-frame:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.pyr-frame.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 15%,transparent)}',
      '.pyr-frame .pyr-where{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pyr-frame .pyr-line{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280);font-size:10.5px}',
      '.pyr-var{display:flex;align-items:baseline;gap:6px;width:100%;box-sizing:border-box;padding:2px 7px;border:none;border-radius:5px;',
      'background:transparent;color:inherit;font-family:' + MONO + ';font-size:11.5px;text-align:left}',
      '.pyr-var.is-ref{cursor:pointer}',
      '.pyr-var.is-ref:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.pyr-var .pyr-k{color:var(--dsw-alias-label-secondary,#6b7280);flex:0 0 auto}',
      '.pyr-var .pyr-v{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pyr-var .pyr-t{color:var(--dsw-alias-label-secondary,#6b7280);font-size:10px;flex:0 0 auto}',
      '.pyr-var.is-error .pyr-v{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.pyr-sec-empty{padding:1px 10px 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.pyr-watch{display:flex;gap:4px;padding:0 6px 6px}',
      '.pyr-watch input{flex:1 1 auto;min-width:0;height:24px;padding:0 7px;font:inherit;font-size:11.5px;border-radius:6px;',
      'font-family:' + MONO + ';color:var(--dsw-alias-label-primary,#1f2328);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));outline:none}',
      '.pyr-watch input:focus{border-color:var(--dsw-alias-brand-primary,#4d9fff)}',
      '.pyr-debugbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 auto;padding:5px 12px;',
      'border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 25%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d9fff) 7%,transparent)}',
      '.pyr-debugbar .pyr-why{font-size:11.5px;color:var(--dsw-alias-state-error-primary,#e5484d);',
      'max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // ── editor gutter ────────────────────────────────────────────────
      '.pyr-gutter-clip{flex:0 0 auto;overflow:hidden;',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}',
      '.pyr-gutter{padding:0 0 24px;font-family:' + MONO + ';font-size:12px;line-height:19px;',
      'color:var(--dsw-alias-label-secondary,#6b7280);user-select:none}',
      '.pyr-ln{position:relative;height:19px;line-height:19px;padding-right:9px;text-align:right;cursor:pointer}',
      '.pyr-ln:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}',
      '.pyr-ln-num{opacity:.78}',
      '.pyr-ln.is-bp .pyr-ln-num{opacity:1;color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:700}',
      '.pyr-ln.is-bp::before{content:"";position:absolute;left:5px;top:6px;width:8px;height:8px;border-radius:50%;',
      'background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.pyr-ln.is-cur .pyr-ln-num{opacity:1;color:var(--dsw-alias-brand-primary,#4d9fff);font-weight:700}',
      '.pyr-cur{position:absolute;left:0;right:0;height:19px;pointer-events:none;z-index:0;',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ffb86b) 16%,transparent);',
      'box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary,#ffb86b)}',
    ].join('\n')

    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.getElementById) return
        if (document.getElementById(STYLE_ID) !== null) return
        var tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.textContent = CSS
        ;(document.head || document.documentElement).appendChild(tag)
      } catch (error) {
        /* styling is cosmetic: never let it break the panel */
      }
    }

    // ── icons ────────────────────────────────────────────────────────────
    function svg(paths, size) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size || 13, height: size || 13, 'aria-hidden': 'true', style: { display: 'block' } },
        paths.map(function (d, index) {
          return h('path', { key: 'i' + index, d: d, fill: 'currentColor' })
        }),
      )
    }

    var ICO_PLAY = ['M5.3 3.1v9.8L13 8z']
    var ICO_BUG = [
      'M8 1.7a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z',
      'M6.1 4.3h3.8a1.7 1.7 0 0 1 1.7 1.7v4.2a3.6 3.6 0 1 1-7.2 0V6a1.7 1.7 0 0 1 1.7-1.7z',
      'M3.1 6.1h1.8v1.3H3.1zM11.1 6.1h1.8v1.3h-1.8zM3.5 9.7h1.6V11H3.5zM10.9 9.7h1.6V11h-1.6z',
    ]
    var ICO_STOP = ['M4.7 4.7h6.6v6.6H4.7z']
    var ICO_CHECK = ['M6.6 11.3 3.6 8.3l1.2-1.2 1.8 1.8 4.6-4.6 1.2 1.2z']
    var ICO_REFRESH = ['M8 2.4V4.2a3.8 3.8 0 1 1-3.7 4.6l1.7-.4A2.1 2.1 0 1 0 8 6v1.8l3-2.7z']
    var ICO_COPY = ['M6.4 2.4h6.2V9H6.4zM3.4 5.4h6.2v8.2H3.4z']
    var ICO_BROOM = ['M9.4 2.2 13.8 6.6 7.6 12.8 3.2 8.4zM3.2 8.4 1.4 14.6 7.6 12.8z']
    var ICO_FILE = ['M3.4 1.9h5.2l3.9 3.9v8.3H3.4zM8.8 2.4v3.7h3.6']
    var ICO_CONTINUE = ['M4.4 3.1v9.8L11.4 8z', 'M11.6 3.1h1.9v9.8h-1.9z']
    var ICO_STEP_OVER = ['M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z', 'M7.2 6.4h1.6v5.2h3.1L8 14.2 4.1 11.6h3.1z']
    var ICO_STEP_IN = ['M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z', 'M7.2 6.4h1.6v5.2h3.1L8 14.2 4.1 11.6h3.1z']
    var ICO_STEP_OUT = ['M8 1.8a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z', 'M7.2 6.2h1.6v5.4h3.1L8 14.2 4.1 11.6h3.1z']
    var ICO_PAUSE = ['M4.6 3.3h2.5v9.4H4.6zM8.9 3.3h2.5v9.4H8.9z']
    var ICO_CHEVRON = ['M6.2 4.4 10 8l-3.8 3.6z']
    var ICO_TRASH = ['M6.1 2.3h3.8v1.2h3v1.4h-1v8.8H4.1V4.9h-1V3.5h3zM5.5 6.2v5.7h1.2V6.2zM9.3 6.2v5.7h1.2V6.2z']

    // ── transport ────────────────────────────────────────────────────────
    /** Same-origin path (cookie auth comes along for free). */
    function endpoint(method, query) {
      var url = new URL(API_ROOT + method, document.baseURI)
      if (query !== undefined && query !== null) {
        for (var key in query) {
          var value = query[key]
          if (value === undefined || value === null || value === '') continue
          url.searchParams.set(key, String(value))
        }
      }
      return url.pathname + url.search
    }

    function post(method, payload) {
      return fetch(endpoint(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        credentials: 'same-origin',
      }).then(function (response) {
        return response
          .json()
          .catch(function () {
            return { ok: false, error: 'HTTP ' + response.status }
          })
          .then(function (data) {
            if (data && data.ok === true) return data.result
            throw new Error((data && data.error) || 'HTTP ' + response.status)
          })
      })
    }

    // ── controller (one per session, survives tab switches) ──────────────
    function Controller(sessionId, scope) {
      this.sessionId = sessionId
      this.scope = scope || {}
      this.listeners = new Set()
      this.state = {
        cwd: '',
        ready: false,
        busy: false,
        error: '',
        info: '',
        files: [],
        interpreters: [],
        python: '',
        file: '',
        content: '',
        baseContent: '',
        encoding: 'utf-8',
        dirty: false,
        saving: false,
        loadedSize: 0,
        run: { id: '', status: 'idle', mode: 'run', python: '', exit: null, startedAt: 0, ms: 0 },
        log: [],
        logChars: 0,
        logDropped: 0,
        stdin: '',
        stdinHistory: [],
        stdinHistoryIndex: -1,
        breakpoints: {},
        watches: [],
        watchValues: [],
        debug: {
          id: '',
          status: 'idle',
          reason: '',
          threadId: 0,
          file: '',
          line: 0,
          exception: null,
          hasDebugpy: null,
          version: '',
        },
        frames: [],
        frameId: 0,
        scopes: [],
        variables: {},
        expanded: {},
        installing: false,
      }
      this.source = null
      this.seq = 0
      this.refreshedAt = 0
    }

    Controller.prototype.get = function () {
      return this.state
    }

    Controller.prototype.subscribe = function (listener) {
      this.listeners.add(listener)
      var self = this
      return function () {
        self.listeners.delete(listener)
      }
    }

    Controller.prototype.emit = function () {
      var state = this.state
      this.listeners.forEach(function (listener) {
        try {
          listener(state)
        } catch (error) {
          /* a broken view must not break the controller */
        }
      })
    }

    Controller.prototype.patch = function (patch) {
      this.state = Object.assign({}, this.state, patch)
      this.emit()
    }

    Controller.prototype.sessionPayload = function () {
      return { sessionId: this.sessionId, cwd: this.scope.cwd || '' }
    }

    Controller.prototype.load = function (force) {
      var self = this
      if (this.state.busy) return Promise.resolve()
      if (!force && this.state.ready && Date.now() - this.refreshedAt < 5000) return Promise.resolve()
      this.patch({ busy: true, error: '' })
      return post('info', this.sessionPayload())
        .then(function (result) {
          var interpreters = result.interpreters || []
          var remembered = ''
          try {
            remembered = window.localStorage.getItem(LS_PYTHON) || ''
          } catch (error) {
            remembered = ''
          }
          var known = function (path) {
            return interpreters.some(function (item) {
              return item.path === path
            })
          }
          var chosen = remembered !== '' && known(remembered) ? remembered : (interpreters[0] && interpreters[0].path) || ''
          self.refreshedAt = Date.now()
          self.patch({
            cwd: result.cwd,
            files: result.files || [],
            interpreters: interpreters,
            python: self.state.python !== '' && known(self.state.python) ? self.state.python : chosen,
            ready: true,
            busy: false,
            error: interpreters.length === 0 ? '没有找到可用的 Python 解释器，可在插件配置里指定 python 路径' : '',
          })
          self.loadBreakpoints()
          self.checkDebugpy()
        })
        .catch(function (error) {
          self.patch({ busy: false, error: error.message || String(error) })
        })
    }

    Controller.prototype.open = function (path, options) {
      var self = this
      if (!path) return Promise.resolve()
      var force = options !== undefined && options !== null && options.force === true
      if (!force && this.state.file !== '' && this.state.dirty) {
        var proceed = true
        try {
          proceed = window.confirm('当前文件有未保存的修改，仍然切换吗？')
        } catch (error) {
          proceed = true
        }
        if (!proceed) return Promise.resolve()
      }
      this.patch({ busy: true, error: '', info: '' })
      return post('read', Object.assign({ path: path }, this.sessionPayload()))
        .then(function (result) {
          var files = self.state.files
          var known = files.some(function (item) {
            return item.path === result.relative
          })
          self.patch({
            file: result.path,
            content: result.content,
            baseContent: result.content,
            encoding: result.encoding === 'utf-8' ? 'utf-8' : result.encoding || 'utf-8',
            dirty: false,
            loadedSize: result.size,
            busy: false,
            files: known
              ? files
              : files.concat([{ path: result.relative, size: result.size }]).sort(function (a, b) {
                  return a.path.localeCompare(b.path)
                }),
          })
        })
        .catch(function (error) {
          self.patch({ busy: false, error: error.message || String(error) })
        })
    }

    Controller.prototype.setContent = function (content) {
      this.patch({ content: content, dirty: content !== this.state.baseContent, info: '' })
    }

    Controller.prototype.save = function () {
      var self = this
      if (this.state.file === '' || this.state.saving) return Promise.resolve()
      this.patch({ saving: true, error: '', info: '' })
      return post('save', Object.assign({ path: this.state.file, content: this.state.content }, this.sessionPayload()))
        .then(function () {
          self.patch({ saving: false, dirty: false, baseContent: self.state.content, info: '已保存' })
          return true
        })
        .catch(function (error) {
          self.patch({ saving: false, error: error.message || String(error) })
          return false
        })
    }

    Controller.prototype.choosePython = function (path) {
      this.patch({ python: path })
      try {
        window.localStorage.setItem(LS_PYTHON, path)
      } catch (error) {
        /* private mode: the choice just will not persist */
      }
      this.checkDebugpy()
    }

    Controller.prototype.appendLog = function (stream, seq, text) {
      var log = this.state.log.concat([{ seq: seq, stream: stream, text: text }])
      var chars = this.state.logChars + text.length
      var dropped = this.state.logDropped
      while (chars > MAX_LOG_CHARS && log.length > 1) {
        var gone = log.shift()
        chars -= gone.text.length
        dropped += 1
      }
      this.patch({ log: log, logChars: chars, logDropped: dropped })
    }

    Controller.prototype.run = function (mode) {
      var self = this
      if (this.state.file === '' || this.state.run.status === 'running' || this.state.run.status === 'starting') {
        return Promise.resolve()
      }
      this.patch({
        error: '',
        info: '',
        log: [],
        logChars: 0,
        logDropped: 0,
        run: {
          id: '',
          status: 'starting',
          mode: mode,
          python: this.state.python,
          exit: null,
          startedAt: Date.now(),
          ms: 0,
        },
      })
      this.seq = 0
      return post(
        'run',
        Object.assign({ path: this.state.file, mode: mode, python: this.state.python }, this.sessionPayload()),
      )
        .then(function (result) {
          self.patch({
            run: Object.assign({}, self.state.run, { id: result.id, status: 'running', python: result.python }),
          })
          self.attach(result.id)
        })
        .catch(function (error) {
          self.patch({
            run: Object.assign({}, self.state.run, { status: 'idle' }),
            error: error.message || String(error),
          })
        })
    }

    Controller.prototype.attach = function (id) {
      var self = this
      this.detach()
      var source = new EventSource(endpoint('events', { id: id, from: this.seq }))
      this.source = source
      source.onmessage = function (event) {
        var data
        try {
          data = JSON.parse(event.data)
        } catch (error) {
          return
        }
        if (data === null || typeof data !== 'object' || typeof data.type !== 'string') return
        if (data.type === 'chunk') {
          if (typeof data.seq === 'number') self.seq = Math.max(self.seq, data.seq + 1)
          self.appendLog(data.stream, data.seq, String(data.text === undefined ? '' : data.text))
          return
        }
        if (data.type === 'start') {
          self.patch({ run: Object.assign({}, self.state.run, { status: 'running', startedAt: data.startedAt }) })
          return
        }
        if (data.type === 'debug') {
          self.handleDebugEvent(data)
          return
        }
        if (data.type === 'exit') {
          var wasInstall = self.state.run.mode === 'install'
          self.patch({
            run: Object.assign({}, self.state.run, {
              status: 'exited',
              exit: { code: data.code, signal: data.signal },
              ms: typeof data.ms === 'number' ? data.ms : 0,
            }),
            debug: Object.assign({}, self.state.debug, {
              status: self.state.debug.status === 'idle' ? 'idle' : 'exited',
            }),
          })
          self.detach()
          // `pip install debugpy` just finished: re-probe so the Debug button
          // turns on without a reload.
          if (wasInstall) self.checkDebugpy()
          return
        }
        if (data.type === 'error') self.patch({ error: data.message || '运行出错' })
      }
      source.onerror = function () {
        // The host closes the stream after `exit`; a genuine failure leaves the
        // connection dead, so stop EventSource's automatic reconnect loop.
        if (self.source !== source) return
        source.close()
        self.source = null
        if (self.state.run.status === 'running') {
          self.patch({
            error: '输出连接已断开（运行可能已经结束）',
            run: Object.assign({}, self.state.run, { status: 'exited' }),
          })
        }
      }
    }

    Controller.prototype.detach = function () {
      if (this.source === null) return
      try {
        this.source.close()
      } catch (error) {
        /* already closed */
      }
      this.source = null
    }

    Controller.prototype.stop = function () {
      var self = this
      if (this.state.run.status !== 'running') return Promise.resolve()
      return post('stop', { id: this.state.run.id })
        .then(function () {
          self.patch({ info: '已请求停止' })
        })
        .catch(function (error) {
          self.patch({ error: error.message || String(error) })
        })
    }

    Controller.prototype.sendStdin = function () {
      var self = this
      var text = this.state.stdin
      if (this.state.run.status !== 'running' || text === '') return
      var history = this.state.stdinHistory.concat([text]).slice(-MAX_STDIN_HISTORY)
      this.patch({ stdin: '', stdinHistory: history, stdinHistoryIndex: -1 })
      post('stdin', { id: this.state.run.id, text: text + '\n' }).catch(function (error) {
        self.patch({ error: error.message || String(error) })
      })
    }

    Controller.prototype.setStdin = function (text) {
      this.patch({ stdin: text, stdinHistoryIndex: -1 })
    }

    Controller.prototype.history = function (delta) {
      var history = this.state.stdinHistory
      if (history.length === 0) return
      var index = this.state.stdinHistoryIndex
      index = index < 0 ? history.length - 1 : Math.min(history.length - 1, Math.max(0, index + delta))
      this.patch({ stdin: history[index] || '', stdinHistoryIndex: index })
    }

    Controller.prototype.clearLog = function () {
      this.patch({ log: [], logChars: 0, logDropped: 0 })
    }

    Controller.prototype.logText = function () {
      return this.state.log
        .map(function (chunk) {
          return chunk.text
        })
        .join('')
    }

    Controller.prototype.copyLog = function () {
      var self = this
      try {
        var text = this.logText()
        if (text === '') return
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(
            function () {
              self.patch({ info: '已复制 ' + text.length + ' 个字符到剪贴板' })
            },
            function () {
              self.patch({ error: '复制失败：浏览器拒绝了剪贴板写入' })
            },
          )
        } else {
          self.patch({ error: '复制失败：当前环境没有剪贴板权限' })
        }
      } catch (error) {
        self.patch({ error: '复制失败：' + (error.message || String(error)) })
      }
    }

    // ── breakpoints ──────────────────────────────────────────────────────
    // Kept per workspace in localStorage so they survive a reload, and pushed
    // to the live session on every toggle.
    Controller.prototype.storageKey = function (suffix) {
      return suffix + (this.state.cwd || 'default')
    }

    Controller.prototype.loadBreakpoints = function () {
      try {
        var raw = window.localStorage.getItem(this.storageKey(LS_BREAKPOINTS))
        var watches = window.localStorage.getItem(this.storageKey(LS_BREAKPOINTS) + ':watches')
        var patch = {}
        if (raw !== null) {
          var parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') patch.breakpoints = parsed
        }
        if (watches !== null) {
          var list = JSON.parse(watches)
          if (Array.isArray(list)) patch.watches = list.map(String).slice(0, 12)
        }
        if (patch.breakpoints !== undefined || patch.watches !== undefined) this.patch(patch)
      } catch (error) {
        /* storage is a convenience, never a requirement */
      }
    }

    Controller.prototype.persistDebugState = function () {
      try {
        window.localStorage.setItem(this.storageKey(LS_BREAKPOINTS), JSON.stringify(this.state.breakpoints))
        window.localStorage.setItem(this.storageKey(LS_BREAKPOINTS) + ':watches', JSON.stringify(this.state.watches))
      } catch (error) {
        /* ignore */
      }
    }

    Controller.prototype.linesFor = function (file) {
      var lines = this.state.breakpoints[file]
      return Array.isArray(lines) ? lines : []
    }

    Controller.prototype.toggleBreakpoint = function (line) {
      var file = this.state.file
      if (file === '' || !(line > 0)) return
      var lines = this.linesFor(file).slice()
      var at = lines.indexOf(line)
      if (at >= 0) lines.splice(at, 1)
      else lines.push(line)
      lines.sort(function (a, b) {
        return a - b
      })
      var next = Object.assign({}, this.state.breakpoints)
      if (lines.length === 0) delete next[file]
      else next[file] = lines
      this.patch({ breakpoints: next })
      this.persistDebugState()
      var debug = this.state.debug
      if (debug.id !== '' && debug.status !== 'exited' && debug.status !== 'idle') {
        var self = this
        post(
          'debug/breakpoints',
          Object.assign({ id: debug.id, path: file, lines: lines }, this.sessionPayload()),
        ).catch(function (error) {
          self.patch({ error: error.message || String(error) })
        })
      }
    }

    Controller.prototype.debugSummary = function () {
      var count = 0
      var map = this.state.breakpoints
      for (var key in map) {
        if (Array.isArray(map[key])) count += map[key].length
      }
      return count
    }

    // ── debug session ────────────────────────────────────────────────────
    Controller.prototype.checkDebugpy = function () {
      var self = this
      if (this.state.python === '') return Promise.resolve()
      return post('debug/check', { python: this.state.python })
        .then(function (result) {
          self.patch({
            debug: Object.assign({}, self.state.debug, {
              hasDebugpy: result.installed === true,
              version: result.version || '',
            }),
          })
        })
        .catch(function () {
          /* a probe that fails must not flash an error */
        })
    }

    Controller.prototype.startDebug = function () {
      var self = this
      if (this.state.file === '' || this.state.debug.status === 'starting') return Promise.resolve()
      var breakpoints = {}
      var map = this.state.breakpoints
      for (var key in map) {
        if (Array.isArray(map[key]) && map[key].length > 0) breakpoints[key] = map[key]
      }
      this.patch({
        error: '',
        info: '',
        log: [],
        logChars: 0,
        logDropped: 0,
        frames: [],
        scopes: [],
        variables: {},
        expanded: {},
        watchValues: [],
        debug: Object.assign({}, this.state.debug, {
          status: 'starting',
          reason: '',
          exception: null,
          file: '',
          line: 0,
        }),
        run: {
          id: '',
          status: 'starting',
          mode: 'debug',
          python: this.state.python,
          exit: null,
          startedAt: Date.now(),
          ms: 0,
        },
      })
      this.seq = 0
      return post(
        'debug/start',
        Object.assign(
          { path: this.state.file, python: this.state.python, breakpoints: breakpoints, filters: ['uncaught'] },
          this.sessionPayload(),
        ),
      )
        .then(function (result) {
          self.patch({
            debug: Object.assign({}, self.state.debug, { id: result.id, status: 'running' }),
            run: Object.assign({}, self.state.run, { id: result.id, status: 'running' }),
          })
          self.attach(result.id)
        })
        .catch(function (error) {
          self.patch({
            debug: Object.assign({}, self.state.debug, { status: 'idle' }),
            run: Object.assign({}, self.state.run, { status: 'idle' }),
            error: error.message || String(error),
          })
        })
    }

    Controller.prototype.installDebugpy = function () {
      var self = this
      this.patch({
        error: '',
        info: '',
        log: [],
        logChars: 0,
        logDropped: 0,
        installing: true,
        run: {
          id: '',
          status: 'starting',
          mode: 'install',
          python: this.state.python,
          exit: null,
          startedAt: Date.now(),
          ms: 0,
        },
      })
      this.seq = 0
      return post('debug/install', Object.assign({ python: this.state.python }, this.sessionPayload()))
        .then(function (result) {
          self.patch({
            installing: false,
            run: Object.assign({}, self.state.run, { id: result.id, status: 'running' }),
          })
          self.attach(result.id)
        })
        .catch(function (error) {
          self.patch({ installing: false, run: Object.assign({}, self.state.run, { status: 'idle' }), error: error.message || String(error) })
        })
    }

    Controller.prototype.handleDebugEvent = function (data) {
      var body = data.body || {}
      var event = data.event
      if (event === 'started') {
        this.patch({
          debug: Object.assign({}, this.state.debug, { status: 'running', threadId: body.threadId || this.state.debug.threadId }),
        })
        return
      }
      if (event === 'continued') {
        this.patch({
          debug: Object.assign({}, this.state.debug, { status: 'running', reason: '', line: 0, file: '' }),
          frames: [],
          scopes: [],
          variables: {},
        })
        return
      }
      if (event === 'stopped') {
        var threadId = body.threadId || this.state.debug.threadId || 1
        this.patch({
          debug: Object.assign({}, this.state.debug, {
            status: 'paused',
            reason: body.reason || '',
            threadId: threadId,
            exception:
              body.reason === 'exception'
                ? { description: body.description || '', text: body.text || '' }
                : null,
          }),
        })
        this.refreshStack()
        return
      }
      if (event === 'exited') {
        this.patch({ debug: Object.assign({}, this.state.debug, { status: 'exited' }) })
        return
      }
      if (event === 'thread' && body.reason === 'started' && !this.state.debug.threadId) {
        this.patch({ debug: Object.assign({}, this.state.debug, { threadId: body.threadId }) })
      }
    }

    Controller.prototype.debugCommand = function (name, args) {
      var self = this
      var id = this.state.debug.id
      if (id === '') return Promise.resolve(null)
      return post('debug/command', { id: id, command: name, args: args || {} })
        .then(function (result) {
          // A DAP response can be a well-formed "no": evaluate/step on a stale
          // frame answers ok:false with a message. Surface it like a failure.
          if (result !== null && result !== undefined && result.ok === false) {
            throw new Error(result.message || '调试器拒绝了这个命令：' + name)
          }
          return result
        })
        .catch(function (error) {
          self.patch({ error: error.message || String(error) })
          return null
        })
    }

    Controller.prototype.resume = function () {
      return this.debugCommand('continue', { threadId: this.state.debug.threadId || 1 })
    }

    Controller.prototype.pause = function () {
      return this.debugCommand('pause', { threadId: this.state.debug.threadId || 1 })
    }

    Controller.prototype.stepOver = function () {
      return this.debugCommand('next', { threadId: this.state.debug.threadId || 1 })
    }

    Controller.prototype.stepInto = function () {
      return this.debugCommand('stepIn', { threadId: this.state.debug.threadId || 1 })
    }

    Controller.prototype.stepOut = function () {
      return this.debugCommand('stepOut', { threadId: this.state.debug.threadId || 1 })
    }

    Controller.prototype.refreshStack = function () {
      var self = this
      return this.debugCommand('stackTrace', {
        threadId: this.state.debug.threadId || 1,
        startFrame: 0,
        levels: 20,
      }).then(function (result) {
        var body = (result && result.body) || {}
        var frames = Array.isArray(body.stackFrames) ? body.stackFrames : []
        var active = frames[0] || null
        self.patch({
          frames: frames,
          frameId: active === null ? 0 : active.id,
          debug: Object.assign({}, self.state.debug, {
            line: active === null ? 0 : active.line,
            file: active !== null && active.source && active.source.path ? active.source.path : '',
          }),
        })
        if (active !== null) self.loadScopes(active.id)
        self.refreshWatches()
      })
    }

    Controller.prototype.selectFrame = function (frameId) {
      var self = this
      var frame = null
      this.state.frames.forEach(function (item) {
        if (item.id === frameId) frame = item
      })
      if (frame === null) return
      var path = frame.source && frame.source.path ? frame.source.path : ''
      this.patch({
        frameId: frameId,
        debug: Object.assign({}, this.state.debug, { line: frame.line, file: path }),
      })
      if (path !== '' && path !== this.state.file) this.open(path)
      this.loadScopes(frameId)
      this.refreshWatches()
    }

    Controller.prototype.loadScopes = function (frameId) {
      var self = this
      if (!frameId) return Promise.resolve()
      return this.debugCommand('scopes', { frameId: frameId }).then(function (result) {
        var body = (result && result.body) || {}
        var scopes = Array.isArray(body.scopes) ? body.scopes : []
        self.patch({ scopes: scopes })
        scopes.forEach(function (scope) {
          if (scope.variablesReference > 0) self.loadVariables(scope.variablesReference)
        })
      })
    }

    Controller.prototype.loadVariables = function (reference) {
      var self = this
      if (!reference) return Promise.resolve()
      return this.debugCommand('variables', { variablesReference: reference }).then(function (result) {
        var body = (result && result.body) || {}
        var next = Object.assign({}, self.state.variables)
        next[reference] = Array.isArray(body.variables) ? body.variables : []
        self.patch({ variables: next })
      })
    }

    Controller.prototype.toggleExpand = function (reference) {
      if (!reference) return
      var next = Object.assign({}, this.state.expanded)
      if (next[reference]) delete next[reference]
      else next[reference] = true
      this.patch({ expanded: next })
      if (next[reference] && this.state.variables[reference] === undefined) this.loadVariables(reference)
    }

    Controller.prototype.addWatch = function (expression) {
      var text = String(expression || '').trim()
      if (text === '' || this.state.watches.indexOf(text) >= 0) return
      this.patch({ watches: this.state.watches.concat([text]).slice(0, 12) })
      this.persistDebugState()
      this.refreshWatches()
    }

    Controller.prototype.removeWatch = function (index) {
      var watches = this.state.watches.slice()
      var values = this.state.watchValues.slice()
      watches.splice(index, 1)
      values.splice(index, 1)
      this.patch({ watches: watches, watchValues: values })
      this.persistDebugState()
    }

    Controller.prototype.refreshWatches = function () {
      var self = this
      var id = this.state.debug.id
      if (id === '') return
      var frameId = this.state.frameId
      this.state.watches.forEach(function (expression, index) {
        post('debug/command', {
          id: id,
          command: 'evaluate',
          args: { expression: expression, frameId: frameId, context: 'watch' },
        })
          .then(function (result) {
            if (result !== null && result !== undefined && result.ok === false) {
              throw new Error(result.message || '求值失败')
            }
            var body = (result && result.body) || {}
            var values = self.state.watchValues.slice()
            values[index] = {
              expression: expression,
              value: String(body.result === undefined ? '' : body.result),
              type: body.type || '',
            }
            self.patch({ watchValues: values })
          })
          .catch(function (error) {
            var values = self.state.watchValues.slice()
            values[index] = { expression: expression, value: '', type: '', error: error.message || String(error) }
            self.patch({ watchValues: values })
          })
      })
    }

    Controller.prototype.stopDebug = function () {
      var self = this
      var id = this.state.debug.id
      if (id === '') return Promise.resolve()
      return post('debug/stop', { id: id })
        .then(function () {
          self.patch({ info: '已结束调试会话' })
        })
        .catch(function (error) {
          self.patch({ error: error.message || String(error) })
        })
    }

    Controller.prototype.resetDebug = function () {
      this.patch({
        debug: Object.assign({}, this.state.debug, { id: '', status: 'idle', reason: '', exception: null, line: 0, file: '' }),
        frames: [],
        scopes: [],
        variables: {},
        expanded: {},
        watchValues: [],
      })
    }

    // ── React plumbing ───────────────────────────────────────────────────
    var controllers = new Map()

    function acquire(sessionId, scope) {
      var existing = controllers.get(sessionId)
      if (existing !== undefined) return existing
      var created = new Controller(sessionId, scope)
      controllers.set(sessionId, created)
      return created
    }

    function useController(props) {
      var sessionId = (props.scope && props.scope.sessionId) || 'default'
      var ref = React.useRef(null)
      if (ref.current === null) ref.current = acquire(sessionId, props.scope)
      var controller = ref.current
      var pair = React.useState(controller.get())
      var current = pair[0]
      var setCurrent = pair[1]
      React.useEffect(
        function () {
          return controller.subscribe(setCurrent)
        },
        [controller],
      )
      React.useEffect(
        function () {
          controller.load(false)
        },
        [controller],
      )
      return [controller, current]
    }

    function button(label, onClick, options) {
      var opt = options || {}
      var cls = 'pyr-btn'
      if (opt.primary) cls += ' pyr-primary'
      else if (opt.danger) cls += ' pyr-danger'
      else if (opt.ghost) cls += ' pyr-ghost'
      if (opt.icon && !label) cls += ' pyr-btn-icon'
      return h(
        'button',
        {
          type: 'button',
          className: cls,
          title: opt.title || label,
          disabled: opt.disabled === true,
          onClick: opt.disabled === true ? undefined : onClick,
        },
        opt.icon ? svg(opt.icon) : null,
        label || null,
      )
    }

    function formatMs(ms) {
      if (!ms || ms < 0) return ''
      if (ms < 1000) return ms + ' ms'
      return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s'
    }

    // ── python highlighting ──────────────────────────────────────────────
    // A small scanner is enough here: we only need to colour comments,
    // strings, numbers, keywords, decorators and function calls. It runs on
    // every keystroke, so it stays a single pass with one shared regex.
    var MAX_HIGHLIGHT_CHARS = 200000

    var PY_KEYWORDS = {
      False: 1, None: 1, True: 1, and: 1, as: 1, assert: 1, async: 1, await: 1, break: 1,
      class: 1, continue: 1, def: 1, del: 1, elif: 1, else: 1, except: 1, finally: 1, for: 1,
      from: 1, global: 1, if: 1, import: 1, in: 1, is: 1, lambda: 1, nonlocal: 1, not: 1,
      or: 1, pass: 1, raise: 1, return: 1, try: 1, while: 1, with: 1, yield: 1, match: 1, case: 1,
    }

    var PY_BUILTINS = {
      abs: 1, all: 1, any: 1, bool: 1, bytes: 1, callable: 1, chr: 1, dict: 1, dir: 1, divmod: 1,
      enumerate: 1, eval: 1, exec: 1, filter: 1, float: 1, format: 1, frozenset: 1, getattr: 1,
      globals: 1, hasattr: 1, hash: 1, hex: 1, id: 1, input: 1, int: 1, isinstance: 1, issubclass: 1,
      iter: 1, len: 1, list: 1, locals: 1, map: 1, max: 1, min: 1, next: 1, object: 1, oct: 1,
      open: 1, ord: 1, pow: 1, print: 1, property: 1, range: 1, repr: 1, reversed: 1, round: 1,
      set: 1, setattr: 1, slice: 1, sorted: 1, str: 1, sum: 1, super: 1, tuple: 1, type: 1,
      vars: 1, zip: 1, self: 1, cls: 1, Exception: 1, ValueError: 1, TypeError: 1, KeyError: 1,
      RuntimeError: 1, __init__: 1, __main__: 1, __name__: 1,
    }

    var PY_TOKEN = new RegExp(
      [
        '#[^\\n]*',
        '(?:[rRbBuUfF]{0,2}' +
          '"""[\\s\\S]*?"""|' +
          "[rRbBuUfF]{0,2}'''[\\s\\S]*?'''|" +
          '[rRbBuUfF]{0,2}"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"|' +
          "[rRbBuUfF]{0,2}'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'" +
          ')',
        '@[A-Za-z_][\\w.]*',
        '\\b\\d[\\w.]*\\b',
        '\\b[A-Za-z_]\\w*\\b',
      ].join('|'),
      'g',
    )

    function tokenColor(text, index, source) {
      var first = text.charAt(0)
      if (first === '#') return C.synComment
      if (first === '@') return C.synDecorator
      if (PY_STR_PREFIX.test(text) || /^[rRbBuUfF]{0,2}["']/.test(text)) return C.synString
      if (/^[A-Za-z_]/.test(text)) {
        if (PY_KEYWORDS[text] === 1) return C.synKeyword
        if (PY_BUILTINS[text] === 1) return C.synBuiltin
        if (source.charAt(index + text.length) === '(') return C.synFunc
        return ''
      }
      return C.synNumber
    }

    var PY_STR_PREFIX = /^[rRbBuUfF]{1,2}$/

    function highlightPython(content) {
      if (content.length > MAX_HIGHLIGHT_CHARS) return null
      var nodes = []
      var carry = 0
      var key = 0
      PY_TOKEN.lastIndex = 0
      var match = PY_TOKEN.exec(content)
      while (match !== null) {
        if (match.index > carry) nodes.push(content.slice(carry, match.index))
        var color = tokenColor(match[0], match.index, content)
        nodes.push(
          color === ''
            ? match[0]
            : h('span', { key: 'tk' + key, style: { color: color, fontStyle: color === C.synComment ? 'italic' : undefined } }, match[0]),
        )
        key += 1
        carry = match.index + match[0].length
        if (match[0].length === 0) PY_TOKEN.lastIndex += 1
        match = PY_TOKEN.exec(content)
      }
      if (carry < content.length) nodes.push(content.slice(carry))
      return nodes
    }

    // ── editor ───────────────────────────────────────────────────────────
    function Editor(props) {
      var textareaRef = React.useRef(null)
      var gutterRef = React.useRef(null)
      var highlightRef = React.useRef(null)
      var content = props.content
      var syntax = React.useMemo(
        function () {
          return highlightPython(content)
        },
        [content],
      )
      var lineCount = React.useMemo(
        function () {
          var count = 1
          for (var index = 0; index < content.length; index += 1) {
            if (content.charCodeAt(index) === 10) count += 1
          }
          return count
        },
        [content],
      )
      var numbers = React.useMemo(
        function () {
          if (lineCount > MAX_GUTTER_LINES) return ''
          var parts = []
          for (var line = 1; line <= lineCount; line += 1) parts.push(line)
          return parts.join('\n')
        },
        [lineCount],
      )

      var breakpoints = props.breakpoints || []
      var bpKey = breakpoints.join(',')
      var currentLine = props.currentLine || 0
      var rows = React.useMemo(
        function () {
          if (lineCount > MAX_GUTTER_LINES) return null
          var make = function (line) {
            return function () {
              if (typeof props.onToggleBreakpoint === 'function') props.onToggleBreakpoint(line)
            }
          }
          var list = []
          for (var line = 1; line <= lineCount; line += 1) {
            var isBp = bpKey !== '' && breakpoints.indexOf(line) >= 0
            list.push(
              h(
                'div',
                {
                  key: 'ln' + line,
                  className: 'pyr-ln' + (isBp ? ' is-bp' : '') + (currentLine === line ? ' is-cur' : ''),
                  title: '点击设置 / 取消断点（第 ' + line + ' 行）',
                  onClick: make(line),
                },
                h('span', { className: 'pyr-ln-num' }, line),
              ),
            )
          }
          return list
        },
        [lineCount, bpKey, currentLine],
      )

      var curRef = React.useRef(null)

      function onChange(event) {
        props.onChange(event.target.value)
      }

      function onKeyDown(event) {
        var accel = event.ctrlKey || event.metaKey
        if (event.key === 'Tab') {
          event.preventDefault()
          var start = event.target.selectionStart
          var end = event.target.selectionEnd
          props.onChange(content.slice(0, start) + '    ' + content.slice(end))
          requestAnimationFrame(function () {
            if (textareaRef.current === null) return
            textareaRef.current.selectionStart = start + 4
            textareaRef.current.selectionEnd = start + 4
          })
          return
        }
        if (accel && event.key === 's') {
          event.preventDefault()
          props.onSave()
          return
        }
        if (accel && event.key === 'Enter') {
          event.preventDefault()
          props.onRun(event.shiftKey ? 'debug' : 'run')
        }
      }

      return h(
        'div',
        { style: S.editorRow },
        h(
          'div',
          {
            className: 'pyr-gutter-clip',
            style: { minWidth: 34 + String(lineCount).length * 7 },
          },
          h(
            'div',
            { ref: gutterRef, className: 'pyr-gutter', style: { padding: EDITOR_PAD_TOP + 'px 0 24px' } },
            rows === null ? h('pre', { style: S.gutterText }, numbers) : rows,
          ),
        ),
        h(
          'div',
          { style: S.codeWrap },
          currentLine > 0
            ? h('div', {
                ref: curRef,
                className: 'pyr-cur',
                style: { top: EDITOR_PAD_TOP + (currentLine - 1) * LINE_HEIGHT },
              })
            : null,
          syntax === null
            ? null
            : h('pre', { ref: highlightRef, style: S.highlight, 'aria-hidden': 'true' }, syntax),
          h('textarea', {
            ref: textareaRef,
            style: syntax === null ? S.textarea : Object.assign({}, S.textarea, S.textareaOverlay),
            value: content,
            readOnly: props.readOnly === true,
            spellCheck: false,
            wrap: 'off',
            placeholder: props.readOnly === true
              ? '（非 UTF-8 文件，只读展示）'
              : '# 可以直接在这里编辑，Ctrl+S 保存，Ctrl+Enter 运行',
            onChange: onChange,
            onKeyDown: onKeyDown,
            onScroll: function (event) {
              var top = event.target.scrollTop
              var left = event.target.scrollLeft
              if (gutterRef.current !== null) gutterRef.current.style.transform = 'translateY(' + -top + 'px)'
              if (curRef.current !== null) curRef.current.style.transform = 'translateY(' + -top + 'px)'
              if (highlightRef.current !== null) {
                highlightRef.current.scrollTop = top
                highlightRef.current.scrollLeft = left
              }
            },
          }),
        ),
      )
    }

    // ── log ──────────────────────────────────────────────────────────────
    function LogPanel(props) {
      var state = props.state
      var ref = React.useRef(null)
      var pinned = React.useRef(true)

      React.useEffect(
        function () {
          var node = ref.current
          if (node === null || !pinned.current) return
          node.scrollTop = node.scrollHeight
        },
        [state.log],
      )

      return h(
        'div',
        {
          ref: ref,
          className: 'pyr-log',
          onScroll: function (event) {
            var node = event.target
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          },
        },
        state.logDropped > 0
          ? h('div', { className: 'pyr-empty-chunk' }, '（较早的输出已省略 ' + state.logDropped + ' 段）')
          : null,
        state.log.length === 0
          ? h('span', { className: 'pyr-empty-chunk' }, '还没有输出。点上面的「运行」或「调试」开始。')
          : state.log.map(function (chunk) {
              return h('span', { key: chunk.seq, style: { color: LOG_COLORS[chunk.stream] || 'inherit' } }, chunk.text)
            }),
      )
    }

    function baseName(path) {
      return String(path === null || path === undefined ? '' : path).split(/[\\/]/).pop()
    }

    // ── workbench ────────────────────────────────────────────────────────
    function Workbench(props) {
      ensureStyles()
      var pair = useController(props)
      var controller = pair[0]
      var state = pair[1]
      var run = state.run
      var debug = state.debug
      var debugging = debug.status === 'starting' || debug.status === 'running' || debug.status === 'paused'
      var paused = debug.status === 'paused'
      var running = run.status === 'running' || run.status === 'starting'
      var stdinRef = React.useRef(null)
      var watchPair = React.useState('')
      var watchInput = watchPair[0]
      var setWatchInput = watchPair[1]

      React.useEffect(
        function () {
          if (props.path && props.path !== state.file) controller.open(props.path)
        },
        [props.path],
      )

      React.useEffect(
        function () {
          if (running && run.mode === 'run' && stdinRef.current !== null) stdinRef.current.focus()
        },
        [running, run.mode],
      )

      var pill = 'pyr-pill'
      var statusText = '空闲'
      if (debug.status === 'starting') {
        pill += ' is-run is-live'
        statusText = '启动调试'
      } else if (debug.status === 'running') {
        pill += ' is-run is-live'
        statusText = '调试中'
      } else if (debug.status === 'paused') {
        pill += ' is-error'
        statusText = debug.reason === 'exception' ? '已暂停（异常）' : '已暂停'
      } else if (debug.status === 'exited') {
        pill += ' is-ok'
        statusText = '调试结束'
      } else if (run.status === 'starting') {
        pill += ' is-run is-live'
        statusText = run.mode === 'install' ? '安装中' : '启动中'
      } else if (run.status === 'running') {
        pill += ' is-run is-live'
        statusText = run.mode === 'install' ? '安装中' : '运行中'
      } else if (run.status === 'exited' && run.exit) {
        if (run.exit.code === 0) {
          pill += ' is-ok'
          statusText = '已完成'
        } else {
          pill += ' is-error'
          statusText = '退出码 ' + (run.exit.code === null ? run.exit.signal : run.exit.code)
        }
      }

      var fileSelect = h(
        'select',
        {
          className: 'pyr-select',
          value: state.file,
          title: '工作区内的 Python 文件',
          onChange: function (event) {
            if (event.target.value !== '') controller.open(event.target.value)
          },
        },
        h('option', { value: '' }, state.files.length === 0 ? '未发现 .py 文件' : '选择文件…'),
        state.files.map(function (item) {
          return h('option', { key: item.path, value: item.path }, item.path)
        }),
      )

      var pythonSelect = h(
        'select',
        {
          className: 'pyr-select',
          value: state.python,
          title: 'Python 解释器',
          onChange: function (event) {
            controller.choosePython(event.target.value)
          },
        },
        state.interpreters.length === 0 ? h('option', { value: '' }, '无可用解释器') : null,
        state.interpreters.map(function (item) {
          return h('option', { key: item.path, value: item.path }, item.label + ' ' + item.version)
        }),
      )

      var title = h(
        'div',
        { className: 'pyr-title' },
        h('span', { className: 'pyr-dot' }),
        h('span', { className: 'pyr-name', title: state.file || 'Python 运行器' }, baseName(state.file) || 'Python 运行器'),
        state.dirty ? h('span', { className: 'pyr-tag' }, '未保存') : null,
        state.encoding !== 'utf-8' ? h('span', { className: 'pyr-tag' }, state.encoding) : null,
      )

      var toolbar = h(
        'div',
        { className: 'pyr-bar' },
        title,
        props.path ? null : fileSelect,
        pythonSelect,
        h('span', { className: 'pyr-spacer' }),
        h('span', { className: pill }, h('i'), statusText),
        run.status === 'exited' && run.ms > 0 ? h('span', { className: 'pyr-time' }, formatMs(run.ms)) : null,
        button('运行', function () { controller.run('run') }, {
          primary: true,
          icon: ICO_PLAY,
          disabled: state.file === '' || running || debugging,
          title: '运行当前脚本（Ctrl+Enter）',
        }),
        button('调试', function () { controller.startDebug() }, {
          icon: ICO_BUG,
          disabled: state.file === '' || running || debugging || debug.hasDebugpy === false,
          title:
            debug.hasDebugpy === false
              ? '这个解释器没有 debugpy，先安装它'
              : '带断点启动调试器（Ctrl+Shift+Enter）',
        }),
        button('停止', function () {
          if (debugging) controller.stopDebug()
          else controller.stop()
        }, {
          icon: ICO_STOP,
          danger: true,
          disabled: !running && !debugging,
          title: debugging ? '结束调试会话' : '终止进程树',
        }),
        button('保存', function () { controller.save() }, {
          icon: ICO_CHECK,
          ghost: true,
          disabled: !state.dirty || state.saving,
          title: '保存到磁盘（Ctrl+S）',
        }),
        button('', function () { controller.load(true) }, { icon: ICO_REFRESH, ghost: true, title: '重新扫描工作区与解释器' }),
      )

      var openHint = h(
        'div',
        { className: 'pyr-empty' },
        h('div', { className: 'pyr-empty-badge' }, svg(ICO_FILE, 22)),
        h('strong', null, '还没有打开 Python 文件'),
        h(
          'div',
          null,
          '在左侧文件树里点开任意 ',
          h('span', { className: 'pyr-kbd' }, '.py'),
          ' 文件，这里会直接出现编辑器和运行按钮。',
        ),
        h('div', null, '也可以在上方的下拉框里挑一个文件。'),
        h(
          'div',
          null,
          h('span', { className: 'pyr-kbd' }, 'Ctrl+Enter'),
          ' 运行 · ',
          h('span', { className: 'pyr-kbd' }, 'Ctrl+Shift+Enter'),
          ' 调试 · ',
          h('span', { className: 'pyr-kbd' }, 'Ctrl+S'),
          ' 保存',
        ),
        state.files.length === 0
          ? h('div', null, '（工作区 ' + (state.cwd || '') + ' 内没有找到 .py 文件）')
          : null,
      )

      var debugBar = debugging
        ? h(
            'div',
            { className: 'pyr-debugbar' },
            button('继续', function () { controller.resume() }, {
              primary: true,
              icon: ICO_CONTINUE,
              disabled: !paused,
              title: '继续执行（F5）',
            }),
            button('单步跳过', function () { controller.stepOver() }, {
              icon: ICO_STEP_OVER,
              ghost: true,
              disabled: !paused,
              title: '单步跳过（F10）',
            }),
            button('单步进入', function () { controller.stepInto() }, {
              icon: ICO_STEP_IN,
              ghost: true,
              disabled: !paused,
              title: '单步进入（F11）',
            }),
            button('单步跳出', function () { controller.stepOut() }, {
              icon: ICO_STEP_OUT,
              ghost: true,
              disabled: !paused,
              title: '单步跳出（Shift+F11）',
            }),
            button('暂停', function () { controller.pause() }, {
              icon: ICO_PAUSE,
              ghost: true,
              disabled: paused || debug.status !== 'running',
              title: '暂停执行',
            }),
            h('span', { className: 'pyr-spacer' }),
            debug.exception !== null && debug.exception !== undefined
              ? h(
                  'span',
                  { className: 'pyr-why', title: debug.exception.description || debug.exception.text || '' },
                  debug.exception.description || debug.exception.text || '未捕获的异常',
                )
              : null,
            button('结束', function () { controller.stopDebug() }, { icon: ICO_STOP, danger: true, title: '结束调试会话' }),
          )
        : null

      var renderVariable = function (variable, depth) {
        var reference = variable.variablesReference || 0
        var expanded = reference > 0 && state.expanded[reference] === true
        var children = reference > 0 && expanded && depth < 3 ? state.variables[reference] : null
        var row = h(
          'div',
          {
            key: 'v' + depth + ':' + variable.name,
            className: 'pyr-var' + (reference > 0 ? ' is-ref' : ''),
            style: { paddingLeft: 7 + depth * 13 + 'px' },
            title: variable.name,
            onClick:
              reference > 0
                ? function () {
                    controller.toggleExpand(reference)
                  }
                : undefined,
          },
          h('span', { className: 'pyr-k' }, reference > 0 ? (expanded ? '▾ ' : '▸ ') : '') ,
          h('span', { className: 'pyr-k' }, variable.name),
          h('span', { className: 'pyr-v' }, String(variable.value)),
          variable.type ? h('span', { className: 'pyr-t' }, String(variable.type)) : null,
        )
        var out = [row]
        if (children !== null && children !== undefined) {
          children.forEach(function (child) {
            out = out.concat(renderVariable(child, depth + 1))
          })
        }
        return out
      }

      var aside = debug.id !== ''
        ? h(
            'div',
            { className: 'pyr-aside' },
            h(
              'div',
              { className: 'pyr-sec' },
              h('h4', null, '调用栈'),
              h(
                'div',
                { className: 'pyr-sec-body' },
                state.frames.length === 0
                  ? h('div', { className: 'pyr-sec-empty' }, paused ? '没有可用的栈帧' : '暂停时显示调用栈')
                  : state.frames.map(function (frame) {
                      var file = frame.source && frame.source.path ? frame.source.path : ''
                      return h(
                        'button',
                        {
                          key: 'f' + frame.id,
                          type: 'button',
                          className: 'pyr-frame' + (frame.id === state.frameId ? ' is-active' : ''),
                          title: file,
                          onClick: function () {
                            controller.selectFrame(frame.id)
                          },
                        },
                        h('span', { className: 'pyr-where' }, frame.name + '  ' + baseName(file)),
                        h('span', { className: 'pyr-line' }, ':' + frame.line),
                      )
                    }),
              ),
            ),
            h(
              'div',
              { className: 'pyr-sec' },
              h('h4', null, '变量'),
              h(
                'div',
                { className: 'pyr-sec-body' },
                state.scopes.length === 0
                  ? h('div', { className: 'pyr-sec-empty' }, '暂停时显示局部变量')
                  : state.scopes.map(function (scope) {
                      var list = state.variables[scope.variablesReference] || []
                      return h(
                        'div',
                        { key: 's' + scope.name },
                        h('div', { className: 'pyr-sec-empty' }, scope.name),
                        list.length === 0 ? null : list.map(function (variable) { return renderVariable(variable, 0) }),
                      )
                    }),
              ),
            ),
            h(
              'div',
              { className: 'pyr-sec' },
              h('h4', null, '监视'),
              h(
                'div',
                { className: 'pyr-watch' },
                h('input', {
                  value: watchInput,
                  spellCheck: false,
                  placeholder: '表达式，回车添加',
                  onChange: function (event) {
                    setWatchInput(event.target.value)
                  },
                  onKeyDown: function (event) {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    controller.addWatch(watchInput)
                    setWatchInput('')
                  },
                }),
              ),
              h(
                'div',
                { className: 'pyr-sec-body' },
                state.watches.length === 0
                  ? h('div', { className: 'pyr-sec-empty' }, '例如 total、df.shape、i > 3')
                  : state.watches.map(function (expression, index) {
                      var value = state.watchValues[index]
                      return h(
                        'div',
                        { key: 'w' + expression, className: 'pyr-var' + (value && value.error ? ' is-error' : '') },
                        h(
                          'span',
                          {
                            className: 'pyr-k',
                            style: { cursor: 'pointer' },
                            title: '点击删除这条监视',
                            onClick: function () {
                              controller.removeWatch(index)
                            },
                          },
                          '× ' + expression,
                        ),
                        h('span', { className: 'pyr-v' }, value ? value.error || value.value : '…'),
                      )
                    }),
              ),
            ),
          )
        : null

      var installNote =
        debug.hasDebugpy === false
          ? h(
              'div',
              { className: 'pyr-note' },
              h('span', null, '这个解释器还没有 debugpy，图形调试需要它（运行不受影响）。'),
              button('安装 debugpy', function () { controller.installDebugpy() }, {
                primary: true,
                disabled: running,
                title: 'pip install debugpy（输出会显示在下方日志里）',
              }),
            )
          : null

      var stdinRow =
        running && run.mode === 'run'
          ? h(
              'div',
              { className: 'pyr-stdin' },
              h('span', { className: 'pyr-stdin-tag' }, 'stdin'),
              h('input', {
                ref: stdinRef,
                value: state.stdin,
                spellCheck: false,
                placeholder: '输入一行文本后回车，发送到程序的标准输入',
                onChange: function (event) {
                  controller.setStdin(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    controller.sendStdin()
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    controller.history(-1)
                    return
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    controller.history(1)
                  }
                },
              }),
            )
          : null

      var logHeader = h(
        'div',
        { className: 'pyr-logbar' },
        h('span', null, '运行日志'),
        state.file !== '' ? h('span', { className: 'pyr-file', title: state.file }, state.file) : null,
        h('span', { className: 'pyr-spacer' }),
        run.python !== '' ? h('span', { className: 'pyr-file', title: run.python }, baseName(run.python)) : null,
        button('清空', function () { controller.clearLog() }, { ghost: true, title: '清空日志显示（不影响正在运行的程序）' }),
        button('复制', function () { controller.copyLog() }, { ghost: true, title: '复制全部日志到剪贴板' }),
      )

      var banner = state.error
        ? h('div', { className: 'pyr-note is-error' }, state.error)
        : state.info !== ''
          ? h('div', { className: 'pyr-note' }, state.info)
          : state.encoding !== 'utf-8'
            ? h(
                'div',
                { className: 'pyr-note' },
                '这个文件是 ' + state.encoding.toUpperCase() + ' 编码，编辑器只读（写回会改掉编码）；运行和调试照常可用。',
              )
            : null

      return h(
        'div',
        { className: 'pyr' },
        toolbar,
        debugBar,
        banner,
        installNote,
        h(
          'div',
          { className: 'pyr-main' },
          h(
            'div',
            { className: 'pyr-upper' },
            h(
              'div',
              { className: 'pyr-edit' },
              state.file !== ''
                ? h(Editor, {
                    content: state.content,
                    readOnly: state.encoding !== 'utf-8',
                    breakpoints: state.breakpoints[state.file] || [],
                    currentLine: paused && debug.file === state.file ? debug.line : 0,
                    onChange: function (content) {
                      controller.setContent(content)
                    },
                    onSave: function () {
                      controller.save().then(function (saved) {
                        if (saved === true && typeof props.onReload === 'function') props.onReload()
                      })
                    },
                    onRun: function (mode) {
                      if (mode === 'debug') controller.startDebug()
                      else controller.run('run')
                    },
                    onToggleBreakpoint: function (line) {
                      controller.toggleBreakpoint(line)
                    },
                  })
                : openHint,
            ),
            aside,
          ),
          logHeader,
          h(LogPanel, { state: state }),
          stdinRow,
        ),
      )
    }


    // ── extension points ─────────────────────────────────────────────────
    var ICON =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 1.5a1 1 0 0 1 1 1V4h5V2.5a1 1 0 1 1 2 0V4h1A1.5 1.5 0 0 1 15 5.5v8A1.5 1.5 0 0 1 13.5 15h-11A1.5 1.5 0 0 1 1 13.5v-8A1.5 1.5 0 0 1 2.5 4h1V2.5a1 1 0 0 1 1-1Zm8.5 7H3v5h10V8.5Z"/></svg>',
      )

    function apply(ctx) {
      ensureStyles()
      var sidebar = ctx === null || ctx === undefined ? null : ctx.betterSidebar
      if (sidebar === null || sidebar === undefined) return

      if (typeof sidebar.registerTab === 'function') {
        ctx.effect(function () {
          return sidebar.registerTab({
            id: 'py-runner',
            title: function () {
              return 'Python 运行器'
            },
            description: '运行 / 调试工作区内的 Python 脚本，实时查看输出',
            icon: ICON,
            order: 55,
            single: true,
            component: function (props) {
              return h(Workbench, { scope: props.scope, visible: props.visible })
            },
          })
        })
      }

      if (typeof sidebar.registerFileViewer === 'function') {
        ctx.effect(function () {
          return sidebar.registerFileViewer({
            id: 'py-runner-viewer',
            title: 'Python 脚本',
            icon: ICON,
            exts: ['py'],
            priority: 50,
            // Read through this plugin's own API: it knows the workspace root,
            // keeps the file's dirty state and can write back.
            fetchStrategy: 'none',
            component: function (props) {
              return h(Workbench, {
                scope: props.scope,
                path: props.path,
                visible: props.visible,
                onReload: props.onReload,
              })
            },
          })
        })
      }
    }

    exports.apply = apply
    exports.inject = ['betterSidebar']
    exports.Controller = Controller
    // Live controllers by session id — the UI harness drives a session through
    // this map instead of faking DOM events.
    exports.controllers = controllers
    exports.highlightPython = highlightPython
    exports.stylesheet = CSS
    return module.exports
  },
})
