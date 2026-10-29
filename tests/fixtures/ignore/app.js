// A tiny page for tests/visual-ignore.sh with defects of every skippable class: low contrast (a11y), an image that 404s (http-error,
// console error, broken image), a tracker request that 404s, a console error from a widget, and a missing element (/broken has no grid); /status loads three images that answer 403, 500 and 404 from different folders.
const http = require('http');
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery</title></head><body><main><h1>Gallery</h1>${body}</main></body></html>`;
http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/gallery') return send(200, 'text/html', page('<p data-testid="grid" style="color:#bbb;background:#fff">Light grey text</p><img src="/static/images/x.png" alt="x" width="20" height="20"><script>console.error("widget exploded");fetch("/ads/track").catch(function(){});</script>'));
  if (u.pathname === '/status') return send(200, 'text/html', page('<p data-testid="grid">Statuses</p><img src="/static/images/locked.png" alt="a" width="20" height="20"><img src="/static/images/boom.png" alt="b" width="20" height="20"><img src="/other/gone.png" alt="c" width="20" height="20">'));
  if (u.pathname.endsWith('/locked.png')) return send(403, 'text/plain', 'forbidden');
  if (u.pathname.endsWith('/boom.png')) return send(500, 'text/plain', 'broken');
  if (u.pathname === '/clean') return send(200, 'text/html', page('<p data-testid="grid">All fine</p>'));
  if (u.pathname === '/broken') return send(200, 'text/html', page('<p>No grid here</p>'));
  send(404, 'text/plain', 'not found');
}).listen(+process.argv[2], '127.0.0.1');
