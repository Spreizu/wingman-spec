#!/usr/bin/env node
/**
 * byteident.cjs ORIG NEW [--comma] [--final-eol]
 * Asserts that a fixer left everything outside its own lines byte-identical: every line of ORIG (with its line ending)
 * must still be in NEW, in the same order; NEW may only ADD lines. Exit 0 and print the number of added lines, or exit 1
 * and name the first original line that was changed, moved or lost.
 *   --comma      a trailing comma may be added or removed on a line (a JSON list gets one more element)
 *   --final-eol  a last line without a newline may get one (a line was appended after it)
 */
const fs = require('fs');
const [a, b] = process.argv.slice(2);
const comma = process.argv.includes('--comma'); const finalEol = process.argv.includes('--final-eol');
const lines = (s) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
const A = lines(fs.readFileSync(a, 'latin1')); const B = lines(fs.readFileSync(b, 'latin1'));
const norm = (l, last) => { let x = l; if (finalEol && last) x = x.replace(/\r?\n$/, ''); if (comma) x = x.replace(/,(\r?\n|$)/, '$1'); return x; };
let j = 0; let added = 0;
for (let i = 0; i < A.length; i++) {
  const want = norm(A[i], i === A.length - 1);
  while (j < B.length && norm(B[j], i === A.length - 1) !== want) { j++; added++; }
  if (j >= B.length) { console.log(`line ${i + 1} was changed, moved or lost: ${JSON.stringify(A[i].slice(0, 80))}`); process.exit(1); }
  j++;
}
added += B.length - j;
console.log(added);
