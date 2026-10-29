// A tiny page for tests/visual-steps.sh: a menu toggle that a media query hides at 800px and wider (the panel is then always shown),
// a button that an overlay covers, and a plain page. Usage: node app.js <port>
const http = require('http');
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages</title>
<style>#panel{display:none}.open #panel{display:block}.menu-toggle{padding:8px}@media (min-width:800px){.menu-toggle{display:none}#panel{display:block}}.cover{position:fixed;inset:0;background:rgba(255,255,255,.01);z-index:10}</style></head><body><main><h1>Pages</h1>${body}</main></body></html>`;
http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/menu') return send(200, 'text/html', page('<button class="menu-toggle" onclick="document.body.classList.add(\'open\')">Menu</button><p data-testid="grid">Grid</p><nav id="panel" data-testid="panel">Links</nav>'));
  if (u.pathname === '/covered') return send(200, 'text/html', page('<p data-testid="grid">Grid</p><button class="save" onclick="document.body.classList.add(\'open\')">Save</button><nav id="panel" data-testid="panel">Saved</nav><div class="cover"></div>'));
  send(404, 'text/plain', 'not found');
}).listen(+process.argv[2], '127.0.0.1');
