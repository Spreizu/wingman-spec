export const STYLES = `
:root {
  --gap: 16px;
  --section-gap: 16px; /* the one vertical gap between top-level sections of a page */
  --radius: 12px;
  --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, rgba(127,127,127,.08)));
  --line: var(--vscode-panel-border, rgba(127,127,127,.25));
  --muted: var(--vscode-descriptionForeground, rgba(127,127,127,.9));
  --accent: var(--vscode-textLink-foreground, #4aa3ff);
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font: 13px/1.55 var(--vscode-font-family, system-ui, sans-serif);
}
h1, h2, h3, h4 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
button { font: inherit; color: inherit; cursor: pointer; }
.ico { flex: none; vertical-align: -3px; }

.tone-ok { --c: var(--vscode-charts-green, #3fb950); }
.tone-warn { --c: var(--vscode-charts-yellow, #d29922); }
.tone-bad { --c: var(--vscode-charts-red, #f85149); }
.tone-info { --c: var(--vscode-charts-blue, #4aa3ff); }
.tone-accent { --c: var(--vscode-charts-purple, #a371f7); }
.tone-muted { --c: var(--vscode-descriptionForeground, #8b949e); }

/* shell */
.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
.nav { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 18px 12px; border-right: 1px solid var(--line); background: var(--vscode-sideBar-background, transparent); }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.brand-mark { width: 26px; height: 26px; flex: none; }
.nav-label { margin: 18px 8px 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
.nav-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; background: none; text-align: left; color: var(--vscode-foreground); }
.nav-item:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
.nav-item.active { background: var(--vscode-list-activeSelectionBackground, rgba(127,127,127,.2)); color: var(--vscode-list-activeSelectionForeground, inherit); }
.nav-item .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item .count { font-size: 11px; color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; margin: 0 3px; }
.main { padding: 28px 36px 64px; max-width: 1180px; width: 100%; min-width: 0; }

/* header */
/* top-level sections of a page: one gap between consecutive boxes (zero specificity, so a larger margin of its own still wins) */
:where(.main > * + *) { margin-top: var(--section-gap); }
.page-head { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-bottom: 22px; }
.page-head .titles { flex: 1 1 160px; min-width: 0; }
.page-head h1 { font-size: 22px; }
.page-head .sub { color: var(--muted); margin-top: 3px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.page-head .aside { display: flex; gap: 8px; align-items: center; }
.icon-btn { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); }
.icon-btn:hover { border-color: var(--vscode-focusBorder, var(--accent)); }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 7px; border: 1px solid var(--line); background: var(--card); }
.btn:hover { border-color: var(--vscode-focusBorder, var(--accent)); }
.btn.primary { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
.btn.primary:hover { background: var(--vscode-button-hoverBackground, #026ec1); border-color: transparent; }
.btn.agent { border-style: dashed; }
.btn.agent.primary { border-style: solid; }
.btn:disabled { opacity: .55; cursor: default; }
.btn:disabled:hover { border-color: var(--line); }
.actions .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.actions .why { margin: 8px 0 0; padding: 0; list-style: none; font-size: 12px; }
.actions .result { margin-top: 10px; padding: 8px 10px; border-radius: 7px; border-left: 3px solid var(--line); min-width: 0; }
.actions .result.tone-ok, .actions .result.tone-bad { border-left-color: var(--c); }
.actions .req { margin: 8px 0 2px; font-size: 12px; font-weight: 600; }
.actions .result ul { margin: 2px 0 0; padding-left: 18px; }
.link { border: 0; background: none; padding: 0; color: var(--accent); display: inline-flex; gap: 4px; align-items: center; cursor: pointer; text-align: left; }
.link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--accent)); }
.link:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; border-radius: 3px; }

/* primitives */
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); border: 1px solid color-mix(in srgb, var(--c) 30%, transparent); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.card.click { cursor: pointer; transition: transform .12s, border-color .12s, box-shadow .12s; }
.card.click:hover { transform: translateY(-2px); border-color: var(--vscode-focusBorder, var(--accent)); box-shadow: 0 6px 18px rgba(0,0,0,.18); }
.grid { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.muted { color: var(--muted); }
.pills { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.pills:empty { display: none; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.spread { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.section-title { display: flex; align-items: center; gap: 8px; margin: 30px 0 12px; font-size: 14px; }
.section-title .count { color: var(--muted); font-weight: 400; }
.ring { position: relative; display: inline-grid; place-items: center; flex: none; }
.ring svg { position: absolute; inset: 0; }
.ring-bg { fill: none; stroke: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); stroke-width: 5; }
.ring-fg { fill: none; stroke: var(--c); stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray .4s; }
.ring-label { font-size: 12px; font-weight: 700; }
.bar { display: block; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); overflow: hidden; min-width: 60px; }
.bar > span { display: block; height: 100%; border-radius: 999px; background: var(--c); }
.empty { text-align: center; padding: 44px 20px; color: var(--muted); border: 1px dashed var(--line); border-radius: var(--radius); }
.empty h3 { color: var(--vscode-foreground); margin: 10px 0 4px; }
.banner { display: flex; gap: 12px; padding: 14px 16px; border-radius: var(--radius); margin-bottom: 18px; color: var(--c); background: color-mix(in srgb, var(--c) 10%, transparent); border: 1px solid color-mix(in srgb, var(--c) 35%, transparent); }
.banner .body { color: var(--vscode-foreground); min-width: 0; }

/* stats */
.stats { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.stat { display: flex; align-items: center; gap: 14px; }
.stat .num { font-size: 26px; font-weight: 700; line-height: 1; }
.stat .lbl { color: var(--muted); font-size: 12px; margin-top: 4px; }
.stat .glyph { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); }

/* attention */
.attention { display: flex; flex-direction: column; gap: 8px; }
.att { display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); cursor: pointer; }
.att:hover { border-color: var(--vscode-focusBorder, var(--accent)); }
.att .ico { color: var(--c); }
.att > :not(.att-main) { flex: none; }
.att-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.att-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.att-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }

/* artifact line under the change title: done = check, missing = muted, skipped = muted and struck through */
.artifacts { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 0 0; padding: 0; list-style: none; font-size: 12px; }
.artifacts li { display: inline-flex; align-items: center; gap: 3px; }
.artifacts .done { color: var(--vscode-foreground); }
.artifacts .done .ico { color: var(--vscode-charts-green, #3fb950); }
.artifacts .skipped { text-decoration: line-through; }

/* change card */
.cc-top { display: flex; gap: 14px; align-items: center; }
.cc-top .t { flex: 1; min-width: 0; }
.cc-top h3 { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
.cc-body { margin-top: 14px; display: flex; flex-direction: column; gap: 12px; }

/* tabs */
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin: 22px 0 18px; overflow-x: auto; }
.tab { border: 0; background: none; padding: 9px 14px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tab:hover { color: var(--vscode-foreground); }
.tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, var(--accent)); font-weight: 600; }
.tab .badge { margin-left: 6px; padding: 0 6px; }
.pane { display: none; }
.pane.active { display: block; }

/* tasks */
.tgroup { margin-bottom: 14px; padding: 0; overflow: hidden; }
.tgroup > details > summary { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; list-style: none; font-weight: 600; }
.tgroup > details > summary::-webkit-details-marker { display: none; }
.tgroup > details > summary .chev { transition: transform .15s; color: var(--muted); }
.tgroup > details[open] > summary .chev { transform: rotate(90deg); }
.tgroup .gcount { margin-left: auto; color: var(--muted); font-weight: 400; display: flex; gap: 10px; align-items: center; }
.tasks { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.task { border-bottom: 1px solid var(--line); }
.task:last-child { border-bottom: 0; }
.task summary, .task > .trow { display: flex; gap: 10px; align-items: center; padding: 9px 16px; list-style: none; cursor: default; }
.task summary { cursor: pointer; }
.task summary::-webkit-details-marker { display: none; }
.task summary:hover, .task > .trow:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); }
.task.next-task { box-shadow: inset 3px 0 0 var(--vscode-charts-yellow, #d29922); background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 7%, transparent); }
.chk { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--muted); background: none; display: grid; place-items: center; color: transparent; padding: 0; flex: none; }
.chk:hover { border-color: var(--vscode-charts-green, #3fb950); }
.task.done .chk { background: var(--vscode-charts-green, #3fb950); border-color: var(--vscode-charts-green, #3fb950); color: #fff; }
.task.done .ttitle { color: var(--muted); text-decoration: line-through; }
.tid { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--muted); min-width: 30px; }
.ttitle { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tdetails { margin: 0; padding: 4px 16px 14px 62px; display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; }
.tdetails dt { color: var(--muted); font-size: 12px; }
.tdetails dd { margin: 0; }

/* markdown */
.md { max-width: 820px; }
.md h1 { font-size: 22px; margin: 22px 0 10px; }
.md h2 { font-size: 17px; margin: 24px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.md h3 { font-size: 14.5px; margin: 18px 0 6px; }
.md h4 { font-size: 13px; margin: 14px 0 4px; }
.md > :first-child { margin-top: 0; }
.md p { margin: 8px 0; }
.md ul, .md ol { padding-left: 22px; margin: 8px 0; }
.md li { margin: 3px 0; }
.md li.task { list-style: none; margin-left: -20px; display: flex; gap: 8px; align-items: baseline; border: 0; }
.md .cb { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--muted); border-radius: 4px; flex: none; transform: translateY(2px); }
.md .cb.on { background: var(--vscode-charts-green, #3fb950); border-color: var(--vscode-charts-green, #3fb950); }
.md pre { padding: 12px 14px; border-radius: 10px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
.md pre code { background: none; padding: 0; }
.md blockquote { margin: 10px 0; padding: 2px 14px; border-left: 3px solid var(--accent); color: var(--muted); }
.md table { border-collapse: collapse; margin: 12px 0; }
.md th, .md td { border: 1px solid var(--line); padding: 6px 12px; text-align: left; }
.md th { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }

/* requirements */
.req { margin-bottom: 12px; }
.focused { outline: 2px solid var(--vscode-focusBorder, var(--accent)); outline-offset: 2px; animation: reveal-flash 1.6s ease-out 1; }
.focused:focus { outline: 2px solid var(--vscode-focusBorder, var(--accent)); }
@keyframes reveal-flash { from { background: color-mix(in srgb, var(--vscode-focusBorder, var(--accent)) 22%, var(--card)); } to { background: var(--card); } }
.insight { margin-top: 8px; }
.why-line { margin: 0 0 6px; }
.insight .pills { margin-top: 0; }
.anchor-row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; margin-top: 6px; font-size: 12px; }
.badge.link { cursor: pointer; }
.badge.link:hover { text-decoration: underline; }
.scn-status { margin-left: auto; display: inline-flex; gap: 8px; align-items: center; font-weight: 400; }
.req-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.req-head h4 { font-size: 14px; }
.req-statement { margin: 8px 0 0; }
.scn { margin-top: 12px; border-radius: 10px; border: 1px solid var(--line); overflow: hidden; }
.scn-name { display: flex; gap: 8px; align-items: center; padding: 7px 12px; font-weight: 600; font-size: 12px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.step-row { display: grid; grid-template-columns: 62px 1fr; gap: 10px; padding: 6px 12px; border-top: 1px solid var(--line); align-items: baseline; }
.kw { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-align: center; padding: 1px 0; border-radius: 5px; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
.diff { margin: 10px 0 0; padding: 8px 0; border-radius: 10px; border: 1px solid var(--line); font: 12px/1.5 var(--vscode-editor-font-family, monospace); overflow-x: auto; }
.diff div { padding: 0 12px; white-space: pre-wrap; }
.diff .add { background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 18%, transparent); }
.diff .del { background: color-mix(in srgb, var(--vscode-charts-red, #f85149) 18%, transparent); }
.diff .add::before { content: '+ '; } .diff .del::before { content: '- '; } .diff .same::before { content: '  '; white-space: pre; }
.diff .same { color: var(--muted); }

/* adr */
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 18px; }
.search { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; padding: 6px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--vscode-input-background, var(--card)); }
.search:focus-within { border-color: var(--vscode-focusBorder, var(--accent)); }
.search input { flex: 1; border: 0; outline: 0; background: none; color: var(--vscode-input-foreground, inherit); font: inherit; }
.chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--line); background: none; color: var(--muted); }
.chip:hover { color: var(--vscode-foreground); }
.chip.active { color: var(--c, var(--vscode-foreground)); border-color: var(--c, var(--accent)); background: color-mix(in srgb, var(--c, var(--accent)) 14%, transparent); }
.timeline { position: relative; margin-left: 14px; padding-left: 30px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 14px; }
.tl-item { position: relative; }
.tl-item::before { content: ''; position: absolute; left: -38px; top: 20px; width: 12px; height: 12px; border-radius: 50%; background: var(--c); border: 3px solid var(--vscode-editor-background); }
.adr-num { font-family: var(--vscode-editor-font-family, monospace); font-weight: 700; color: var(--c); }
.adr-card h3 { font-size: 15px; margin: 2px 0 6px; }
.adr-card.superseded h3 { text-decoration: line-through; color: var(--muted); }
.snippet { color: var(--muted); margin: 6px 0 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lineage { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 22px; }
.lineage .sep { width: 22px; height: 2px; background: var(--line); }
.lineage .node { padding: 6px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); cursor: pointer; display: flex; gap: 8px; align-items: center; }
.lineage .node.current { border-color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); cursor: default; }
.sect { margin-bottom: 14px; }
.sect h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin-bottom: 8px; }
.sect.decision { border-color: color-mix(in srgb, var(--vscode-charts-purple, #a371f7) 55%, transparent); background: color-mix(in srgb, var(--vscode-charts-purple, #a371f7) 9%, var(--card)); }
.sect.decision h3 { color: var(--vscode-charts-purple, #a371f7); }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.graph-wrap { overflow: auto; padding: 8px; }
.graph { display: block; }
.gedge { fill: none; stroke: var(--muted); stroke-width: 1.6; }
.garrow { fill: var(--muted); }
.gnode { cursor: pointer; }
.gnode rect { fill: color-mix(in srgb, var(--c) 12%, var(--vscode-editor-background)); stroke: color-mix(in srgb, var(--c) 55%, transparent); stroke-width: 1.4; transition: stroke .12s; }
.gnode:hover rect { stroke: var(--c); stroke-width: 2; }
.gnum { fill: var(--c); font: 700 12px var(--vscode-editor-font-family, monospace); }
.gstatus { fill: var(--muted); font-size: 10.5px; }
.gtitle { fill: var(--vscode-foreground); font-size: 12.5px; font-weight: 600; }
.hidden { display: none !important; }
.board { display: grid; gap: var(--gap); grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; }
.lane { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px; border-radius: var(--radius); background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); border: 1px solid var(--line); }
.lane h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.po-card { padding: 12px 14px; }
@media (max-width: 1100px) { .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .shell { grid-template-columns: 1fr; } .nav { position: static; height: auto; } .main { padding: 20px 16px; } .board { grid-template-columns: 1fr; } }
/* pull request view, change dashboard */
.item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); margin-bottom: 8px; }
.item .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.item .pills { margin-top: 0; justify-content: flex-end; }
.item.click { cursor: pointer; }
.item.click:hover { border-color: var(--vscode-focusBorder, var(--accent)); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tile { padding: 10px 12px; border-radius: 9px; border: 1px solid var(--line); border-left: 3px solid var(--c, var(--line)); }
.tile.empty { border-left-color: var(--line); }
.tile.empty .v { color: var(--muted); font-weight: 500; margin-bottom: 0; }
.tile .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.tile .v { font-size: 15px; font-weight: 600; margin: 2px 0 6px; }
.tile .x { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.dash-notes { margin-top: 10px; font-size: 12px; }
.dash-h { display: flex; align-items: center; gap: 8px; margin: 18px 0 10px; font-size: 13px; }
.block-item { padding: 10px 12px; margin-bottom: 8px; border-radius: 9px; border: 1px solid color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 45%, transparent); background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 7%, transparent); }
.pre-archive { margin-top: 14px; color: var(--muted); font-size: 12px; }
.pre-archive > summary { cursor: pointer; }
.pre-archive .bd { margin: 6px 0 0 18px; padding: 0; }
.block-item .bt { display: flex; align-items: center; gap: 8px; }
.block-item .bd { margin: 6px 0 8px 22px; padding: 0; color: var(--muted); }
.block-item .steps { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; margin-left: 22px; }
.todo { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.todo .cmd { padding: 3px 8px; }
@media (max-width: 900px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.sum .pills { margin-top: 0; }
/* timeline */
.timeline { display: flex; flex-direction: column; gap: var(--section-gap); }
.tl-phase { display: flex; flex-direction: column; gap: 12px; }
.tl-phase-title { font-size: 13px; font-weight: 600; margin: 0; }
.tl-chain { margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid var(--vscode-charts-yellow, #d29922); color: var(--muted); }
.tl-task { font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
.tl-list { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--line); }
.tl-entry > details > summary { list-style: none; cursor: pointer; }
.tl-entry > details > summary::-webkit-details-marker { display: none; }
.tl-line { display: grid; grid-template-columns: 58px 104px 46px minmax(0, 1fr) auto auto; gap: 10px; align-items: baseline; padding: 3px 10px; border-radius: 6px; }
.tl-dur, .tl-gap, .tl-time, .tl-step { white-space: nowrap; }
@media (max-width: 640px) { .tl-line { display: flex; flex-wrap: wrap; gap: 2px 10px; } .tl-sum { flex-basis: 100%; white-space: normal; } .tl-body { margin-left: 10px; } }
.tl-entry > details > summary.tl-line:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
.tl-time, .tl-dur, .tl-gap { font-variant-numeric: tabular-nums; color: var(--muted); }
.tl-dur, .tl-gap { text-align: right; }
.tl-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-entry details[open] .tl-sum { white-space: normal; }
.tl-result { font-size: 12px; }
.tl-passed { color: var(--vscode-charts-green, #3fb950); }
.tl-failed { color: var(--vscode-charts-red, #f85149); }
.tl-decision .tl-line { background: color-mix(in srgb, var(--vscode-charts-purple, #a371f7) 8%, transparent); }
.tl-decision .tl-step { color: var(--vscode-charts-purple, #a371f7); }
.tl-body { margin: 2px 10px 8px 78px; padding: 8px 12px; border-radius: 8px; background: var(--card); }
.tl-detail + .tl-detail { margin-top: 8px; }
.tl-dlabel { font-size: 11px; color: var(--muted); }
.tl-detail ul { margin: 2px 0 0; padding-left: 18px; }
.tl-lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.tl-lane { min-width: 0; }
.tl-lane-task { font-size: 12px; font-weight: 600; margin: 0 0 4px; }
.tl-lane .tl-line { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.tl-lane .tl-sum { flex-basis: 100%; white-space: normal; }
.tl-lane .tl-body { margin-left: 10px; }
.tl-detail pre { margin: 4px 0 0; white-space: pre-wrap; font-size: 12px; max-height: 240px; overflow: auto; }
.tl-idle { margin: 6px 0; padding: 2px 10px; font-size: 12px; color: var(--muted); border-top: 1px dashed var(--line); }
`;
