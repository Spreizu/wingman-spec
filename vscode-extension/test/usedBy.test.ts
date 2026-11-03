import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';
import { traceProject } from './trace-fixture.ts';
import { unitKeys, usedBy, usedByHover } from '../src/model/usedBy.ts';
import type { Walk } from '../src/model/usedBy.ts';

test('unit keys: the doc comment above (any comment syntax, annotations) and the body, not the unit before', () => {
  const ts = ['// @spec a/other', 'function before() {}', '/**', ' * Totals.', ' * @spec a/one, a/two', ' */', '@Memo()', 'function f() {', '  // @spec a/three', '}'];
  assert.deepEqual(unitKeys(ts, 7, 9), ['a/one', 'a/two', 'a/three']);
  assert.deepEqual(unitKeys(ts, 7, 9, false), ['a/one', 'a/two']);
  const go = ['package x', '', '// Total sums the cart.', '// @spec cart/total', 'func (c *Cart) Total() int {', '\treturn 0', '}'];
  assert.deepEqual(unitKeys(go, 4, 6), ['cart/total']);
  assert.deepEqual(unitKeys(go, 0, 1), []);
});

type N = { name: string; keys?: string[]; skip?: boolean };
const graph = (edges: Record<string, string[]>, nodes: Record<string, N>): Walk<N> & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    callers: async (n) => {
      asked.push(n.name);
      return (edges[n.name] ?? []).map((c) => nodes[c] as N);
    },
    keys: async (n) => (n.skip ? undefined : (n.keys ?? [])),
    id: (n) => n.name,
  };
};

test('walks up to the nearest marked callers with the shortest chain, stops at marked ones, skips cycles and excluded callers', async () => {
  const nodes: Record<string, N> = {
    leaf: { name: 'leaf' },
    mid: { name: 'mid' },
    other: { name: 'other' },
    checkout: { name: 'checkout', keys: ['shop/checkout'] },
    refund: { name: 'refund', keys: ['shop/refund', 'shop/checkout'] },
    top: { name: 'top', keys: ['shop/top'] },
    test: { name: 'test', skip: true, keys: ['shop/test'] },
  };
  const w = graph({ leaf: ['mid', 'test', 'leaf'], mid: ['checkout', 'other', 'leaf'], other: ['refund'], checkout: ['top'] }, nodes);
  const r = await usedBy(nodes.leaf as N, w);
  assert.deepEqual(r.found.map((f) => [f.key, f.via.map((n) => n.name).join('>')]), [
    ['shop/checkout', 'checkout>mid'],
    ['shop/refund', 'refund>other>mid'],
  ]);
  assert.equal(r.truncated, false);
  assert.ok(!w.asked.includes('checkout') && !w.asked.includes('test'), 'marked and excluded callers are not walked further');
});

test('the depth and the call budget bound the walk and say so', async () => {
  const chain: Record<string, N> = Object.fromEntries(['f0', 'f1', 'f2', 'f3', 'f4', 'f5'].map((n) => [n, { name: n }]));
  (chain.f5 as N).keys = ['x/deep'];
  const edges = { f0: ['f1'], f1: ['f2'], f2: ['f3'], f3: ['f4'], f4: ['f5'] };
  const deep = await usedBy(chain.f0 as N, graph(edges, chain));
  assert.deepEqual(deep, { found: [], truncated: false }, 'the depth is the documented bound, not a cut');
  assert.equal((await usedBy(chain.f0 as N, graph(edges, chain), 5)).found[0]?.key, 'x/deep');
  const w = graph(edges, chain);
  assert.equal((await usedBy(chain.f0 as N, w, 9, 2)).truncated, true);
  assert.equal(w.asked.length, 2);
});

test('hover text links each requirement and each caller, and says when the walk stopped early', () => {
  const text = usedByHover([{ key: 'shop/checkout', via: [{ name: 'checkout', file: '/r/a.ts', line: 4 }, { name: 'mid', file: '/r/b.ts', line: 9 }] }], new Map([['shop/checkout', 'Guest checkout']]), '/r', true);
  assert.match(text, /^\*\*Used by\*\*\n\n- \[Guest checkout\]\(command:wingmanSpec\.revealRequirement\?/);
  assert.match(text, /`shop\/checkout` via \[checkout\]\(command:wingmanSpec\.openFile\?.*\) → \[mid\]\(/);
  assert.match(text, /Some callers were not searched/);
});

test('editor: hover on an unmarked function asks the call hierarchy and names the requirement; marked functions and call sites get none', async () => {
  const stub = await import('./support/vscodeStub.mjs');
  const { TraceCache } = await import('../src/editor/anchorCode.ts');
  const { registerUsedBy } = await import('../src/editor/usedBy.ts');
  const dir = traceProject();
  const src = ['// @spec billing/add-an-item', 'export function addItem() { return subtotal(); }', 'function subtotal() { return round2(); }', 'function round2() { return 1; }', ''].join('\n');
  writeFileSync(join(dir, 'src', 'cart.ts'), src);
  const file = join(dir, 'src', 'cart.ts');
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  const cache = new TraceCache(store as never);
  const before = stub.host.providers.hover.length;
  registerUsedBy(cache);
  const hover = stub.host.providers.hover[before].provider;
  const item = (name: string, line: number) => ({ name, kind: 11, uri: stub.Uri.file(file), range: new stub.Range(line, 0, line, 60), selectionRange: new stub.Range(line, 9, line, 9 + name.length) });
  const items: Record<string, ReturnType<typeof item>> = { addItem: item('addItem', 1), subtotal: item('subtotal', 2), round2: item('round2', 3) };
  const callers: Record<string, string[]> = { round2: ['subtotal'], subtotal: ['addItem'] };
  let incoming = 0;
  stub.commands.registerCommand('vscode.prepareCallHierarchy', (_u: unknown, p: { line: number; character: number }) => Object.values(items).filter((i) => i.range.start.line === p.line));
  stub.commands.registerCommand('vscode.provideIncomingCalls', (i: { name: string }) => {
    incoming++;
    return (callers[i.name] ?? []).map((c) => ({ from: items[c] }));
  });
  const doc = stub.makeDoc(file, src);
  const h = await hover.provideHover(doc, new stub.Position(3, 11));
  assert.match(h.contents.value, /\[Add an item\]\(command:wingmanSpec\.revealRequirement.*`billing\/add-an-item` via \[addItem\].* → \[subtotal\]/);
  assert.equal(incoming, 2);
  await hover.provideHover(doc, new stub.Position(3, 11));
  assert.equal(incoming, 2, 'the second hover is served from the cache');
  assert.equal(await hover.provideHover(doc, new stub.Position(1, 18)), undefined, 'a marked function: its marker lens says it');
  assert.equal(await hover.provideHover(doc, new stub.Position(2, 32)), undefined, 'a call site, not the declaration');
});
