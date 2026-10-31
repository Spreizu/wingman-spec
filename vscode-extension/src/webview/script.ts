/** Client script for the webview. Plain JavaScript; no framework and no network access. */
export const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var body = document.body;
  var key = body.getAttribute('data-key') || '';
  var saved = vscode.getState() || {};
  var reveal = body.getAttribute('data-reveal') || '0';
  var state = saved.key === key ? saved : { key: key, tab: null, scroll: 0, filter: '', chip: 'all', reveal: null };

  function save() { vscode.setState(state); }
  function post(msg) { vscode.postMessage(msg); }

  function setTab(name) {
    var tabs = document.querySelectorAll('[data-tab]');
    if (!tabs.length) return;
    var found = false;
    tabs.forEach(function (t) { if (t.getAttribute('data-tab') === name) found = true; });
    if (!found) name = tabs[0].getAttribute('data-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    document.querySelectorAll('[data-pane]').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === name); });
    state.tab = name; save();
  }

  function applyFilter() {
    var input = document.querySelector('[data-filter-input]');
    var q = (state.filter || '').toLowerCase();
    if (input && input.value !== state.filter) input.value = state.filter;
    document.querySelectorAll('[data-item]').forEach(function (el) {
      var text = (el.getAttribute('data-text') || '').toLowerCase();
      var cat = el.getAttribute('data-cat') || '';
      var okText = !q || text.indexOf(q) !== -1;
      var okChip = state.chip === 'all' || state.chip === cat;
      el.classList.toggle('hidden', !(okText && okChip));
    });
    document.querySelectorAll('[data-chip]').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-chip') === state.chip); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;

    var a = t.closest('a[href]');
    if (a) { e.preventDefault(); post({ type: 'external', url: a.getAttribute('href') }); return; }

    var toggle = t.closest('[data-toggle]');
    if (toggle) {
      e.preventDefault(); e.stopPropagation();
      post({ type: 'toggle', path: toggle.getAttribute('data-path'), line: Number(toggle.getAttribute('data-line')) });
      return;
    }
    var tab = t.closest('[data-tab]');
    if (tab) { setTab(tab.getAttribute('data-tab')); return; }
    var chip = t.closest('[data-chip]');
    if (chip) { state.chip = chip.getAttribute('data-chip'); save(); applyFilter(); return; }
    var agent = t.closest('[data-agent]');
    if (agent) { e.stopPropagation(); post({ type: 'agent', prompt: agent.getAttribute('data-agent') }); return; }
    var cli = t.closest('[data-cli]');
    if (cli) { e.stopPropagation(); if (!cli.disabled) post({ type: 'cli', action: cli.getAttribute('data-cli'), root: cli.getAttribute('data-root'), change: cli.getAttribute('data-change') || undefined }); return; }
    var term = t.closest('[data-term]');
    if (term) { e.stopPropagation(); post({ type: 'terminal', text: term.getAttribute('data-term') }); return; }
    var cmd = t.closest('[data-cmd]');
    if (cmd) {
      e.stopPropagation();
      var args = [];
      try { args = JSON.parse(cmd.getAttribute('data-args') || '[]'); } catch (err) { args = []; }
      post({ type: 'command', id: cmd.getAttribute('data-cmd'), args: args });
      return;
    }
    var copy = t.closest('[data-copy]');
    if (copy) { e.stopPropagation(); post({ type: 'copy', text: copy.getAttribute('data-copy') }); return; }
    var open = t.closest('[data-open]');
    if (open) {
      e.stopPropagation();
      var line = open.getAttribute('data-line');
      post({ type: 'open', path: open.getAttribute('data-open'), line: line === null ? undefined : Number(line) });
      return;
    }
    if (t.closest('[data-keep]')) return; // inside a card: opening or closing the list must not follow the card's link
    var act = t.closest('[data-action]');
    if (act) { post({ type: act.getAttribute('data-action') }); return; }
    var route = t.closest('[data-route]');
    if (route) {
      try { post({ type: 'navigate', route: JSON.parse(route.getAttribute('data-route')) }); } catch (err) { /* ignore malformed route */ }
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t instanceof HTMLInputElement && t.hasAttribute('data-filter-input')) { state.filter = t.value; save(); applyFilter(); }
  });

  var pending = null;
  window.addEventListener('scroll', function () {
    if (pending) return;
    pending = setTimeout(function () { pending = null; state.scroll = window.scrollY; save(); }, 150);
  });

  setTab(state.tab || body.getAttribute('data-default-tab'));
  applyFilter();
  var focused = document.querySelector('.focused');
  if (focused && reveal !== '0' && state.reveal !== reveal) {
    // opened on a specific requirement or scenario: bring it into view, highlight it, give it keyboard focus
    state.reveal = reveal;
    focused.scrollIntoView({ block: 'center' });
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, state.scroll || 0);
  }
  save();
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t instanceof Element && t.matches('[data-route][role=link]')) { e.preventDefault(); t.click(); }
  });
})();
`;
