// A page for tests/visual-noisy.sh with defects the task did not cause: refused and 404 images, images whose request never answers,
// console errors, axe violations (a button with no name, low contrast, images without alt) and a 2000px-wide bar. The task's own
// element, [data-testid="grid"], is fine. When ./flag exists the page also gets what a task could add: a nameless button inside the
// grid and an image that answers 404. Arguments: <port> <a port nothing listens on>.
const http = require('http'); const fs = require('fs');
const [port, closed] = [+process.argv[2], +process.argv[3]];
const page = () => {
  const n = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join('');
  const added = fs.existsSync('flag');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Noisy</title></head><body><main><h1>Noisy</h1>
<div data-testid="grid"><p>The task's grid</p>${added ? '<button></button><img src="/new404.png" alt="n" width="10" height="10">' : ''}</div><button data-testid="btn" onclick="document.getElementById('p').hidden=false">Open</button><div id="p" hidden data-testid="panel">Panel</div>
${n(5, (i) => `<img src="http://127.0.0.1:${closed}/r${i}.png" alt="r" width="10" height="10">`)}${n(5, (i) => `<img src="/missing/m${i}.png" alt="m" width="10" height="10">`)}${n(3, (i) => `<img src="/hang/h${i}.png" alt="h" width="10" height="10">`)}
<button></button>${n(3, (i) => `<p style="color:#ccc;background:#fff">low contrast ${i}</p>`)}<div style="width:2000px;height:5px;background:#eee"></div>
<script>for(let i=0;i<3;i++)console.error('widget exploded '+i);</script></main></body></html>`;
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/hang/')) return;  // never answers
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page()); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nf');
}).listen(port, '127.0.0.1');
