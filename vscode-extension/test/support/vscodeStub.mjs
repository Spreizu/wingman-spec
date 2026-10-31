// A stand-in for the `vscode` module: enough of the API for the editor layer to run under node, recording what it is asked to do.
// This is NOT VS Code: it checks our wiring (what we register, what our providers return, what commands do), not the editor's behaviour.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; }
  }
}
export class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; }
  static file(p) { return new Uri('file', p); }
  static parse(s) { return s.startsWith('file:') ? new Uri('file', fileURLToPath(s)) : new Uri(s.split(':')[0], s); }
  toString() { return this.scheme === 'file' ? pathToFileURL(this.fsPath).toString() : this.fsPath; }
  with() { return this; }
}
export class Disposable {
  constructor(fn) { this.fn = fn; }
  dispose() { this.fn?.(); }
  static from(...ds) { return new Disposable(() => ds.forEach((d) => d?.dispose?.())); }
}
export class EventEmitter {
  constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return new Disposable(() => { this.l = this.l.filter((x) => x !== fn); }); }; }
  fire(v) { this.l.slice().forEach((f) => f(v)); }
  dispose() { this.l = []; }
}
export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
export class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
export class MarkdownString {
  constructor(v) { this.value = v ?? ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
export class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
export const ViewColumn = { Active: -1, One: 1 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
export const CodeActionKind = { QuickFix: 'quickfix' };
export class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
export class ThemeIcon { constructor(id) { this.id = id; } }
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
export class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(uri, range, text) { this.ops.push({ op: 'replace', uri, range, text }); }
  insert(uri, pos, text) { this.ops.push({ op: 'insert', uri, pos, text }); }
  delete(uri, range) { this.ops.push({ op: 'delete', uri, range }); }
  createFile(uri) { this.ops.push({ op: 'create', uri }); }
}

/** Everything the code under test did, for assertions. */
export const host = {
  settings: {},
  trusted: true,
  commands: new Map(),
  executed: [],
  messages: [],
  terminals: [],
  quickPicks: [],
  quickPickAnswer: undefined,
  providers: { codeLens: [], hover: [], definition: [], codeAction: [], tree: [] },
  collections: new Map(),
  edits: [],
  inputs: [],
  inputAnswer: undefined,
  documents: [],
  handlers: { save: [], open: [], config: [] },
  watchers: [],
  panels: [],
  warningAnswer: undefined,
  infoAnswer: undefined,
  output: [],
  reset() {
    this.settings = {}; this.trusted = true; this.executed = []; this.messages = []; this.terminals = []; this.quickPicks = []; this.quickPickAnswer = undefined;
    this.edits = []; this.inputs = []; this.inputAnswer = undefined; this.documents = []; this.watchers = []; this.panels = []; this.warningAnswer = undefined;
    this.infoAnswer = undefined; this.output = [];
  },
};

export function makeDoc(fsPath, text) {
  const lines = text.split('\n');
  return {
    uri: Uri.file(fsPath), fileName: fsPath, languageId: 'plaintext', lineCount: lines.length,
    getText: (r) => { if (!r) return text; const ls = lines.slice(r.start.line, r.end.line + 1); ls[ls.length - 1] = ls[ls.length - 1].slice(0, r.end.character); ls[0] = ls[0].slice(r.start.character); return ls.join('\n'); }, lineAt: (i) => ({ text: lines[i] ?? '' }),
  };
}

const reg = (list) => (...args) => { const v = args[args.length - 1] === undefined ? args[1] : args[1]; list.push({ selector: args[0], provider: v, extra: args[2] }); return new Disposable(); };
const event = (name) => (fn) => { (host.handlers[name] ??= []).push(fn); return new Disposable(); };
const noEvent = () => new Disposable();

export const workspace = {
  getConfiguration: (section) => ({ get: (key, dflt) => { const k = `${section}.${key}`; return k in host.settings ? host.settings[k] : dflt; } }),
  get isTrusted() { return host.trusted; },
  get textDocuments() { return host.documents; },
  workspaceFolders: [],
  onDidSaveTextDocument: event('save'),
  onDidOpenTextDocument: event('open'),
  onDidCloseTextDocument: noEvent,
  onDidChangeTextDocument: noEvent,
  onDidChangeConfiguration: event('config'),
  onDidChangeWorkspaceFolders: event('folders'),
  onDidGrantWorkspaceTrust: event('trust'),
  onDidCreateFiles: noEvent,
  onDidDeleteFiles: noEvent,
  onDidRenameFiles: noEvent,
  openTextDocument: async (uri) => makeDoc(uri.fsPath, existsSync(uri.fsPath) ? readFileSync(uri.fsPath, 'utf8') : ''),
  createFileSystemWatcher: (pattern) => {
    const [c, ch, d] = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const w = { pattern, onDidCreate: c.event, onDidChange: ch.event, onDidDelete: d.event, fire(fsPath) { ch.fire(Uri.file(fsPath)); }, dispose() {} };
    host.watchers.push(w); return w;
  },
  applyEdit: async (we) => { host.edits.push(we); return true; },
};
export const window = {
  showInformationMessage: async (m, ...items) => { host.messages.push(m); return items.length ? host.infoAnswer : undefined; },
  showWarningMessage: async (m, ...rest) => { host.messages.push(m); return rest.some((x) => typeof x === 'object' && x?.modal) ? host.warningAnswer : undefined; },
  setStatusBarMessage: (m) => { host.messages.push(m); return new Disposable(); },
  createWebviewPanel: (id, title) => {
    const recv = new EventEmitter();
    const p = { id, title, webview: { html: '', cspSource: 'stub', onDidReceiveMessage: (fn) => recv.event(fn), post: (m) => recv.fire(m) }, reveal() {}, onDidDispose: () => new Disposable(), dispose() {} };
    host.panels.push(p); return p;
  },
  showErrorMessage: async (m) => { host.messages.push(m); return undefined; },
  showQuickPick: async (items, opts) => { host.quickPicks.push({ items, opts }); return typeof host.quickPickAnswer === 'function' ? host.quickPickAnswer(items) : host.quickPickAnswer; },
  showInputBox: async (opts) => { host.inputs.push(opts); return host.inputAnswer; },
  createTerminal: (opts) => { const t = { opts, sent: [], shown: false, sendText(s) { this.sent.push(s); }, show() { this.shown = true; }, dispose() {} }; host.terminals.push(t); return t; },
  registerTreeDataProvider: (id, p) => { host.providers.tree.push({ id, provider: p }); return new Disposable(); },
  createOutputChannel: () => ({ appendLine(l) { host.output.push(l); }, append(t) { host.output.push(t); }, show() {}, dispose() {} }),
  withProgress: async (_o, task) => task({ report() {} }),
};
export const commands = {
  registerCommand: (id, fn) => { host.commands.set(id, fn); return new Disposable(() => host.commands.delete(id)); },
  executeCommand: async (id, ...args) => { host.executed.push({ id, args }); const f = host.commands.get(id); return f ? f(...args) : undefined; },
};
export const languages = {
  registerCodeLensProvider: reg(host.providers.codeLens),
  registerHoverProvider: reg(host.providers.hover),
  registerDefinitionProvider: reg(host.providers.definition),
  registerCodeActionsProvider: reg(host.providers.codeAction),
  createDiagnosticCollection: (name) => {
    const map = new Map();
    const c = { name, map, set: (u, d) => map.set(u.toString(), d), get: (u) => map.get(u.toString()), delete: (u) => map.delete(u.toString()), clear: () => map.clear(), dispose() {} };
    host.collections.set(name, c);
    return c;
  },
};
export const env = { clipboard: { writeText: async (t) => { host.clipboard = t; } } };
