// A tiny gated app for tests/roles.sh: /login (form), /dashboard (members), /admin (admins only).
// Users come from the environment (APP_ADMIN_*, APP_VIEWER_*, APP_OPS_*), so no password is written in any file.
const http = require('http');
const E = process.env;
const users = {
  [E.APP_ADMIN_USER]: { pw: E.APP_ADMIN_PASSWORD, role: 'admin' },
  [E.APP_VIEWER_USER]: { pw: E.APP_VIEWER_PASSWORD, role: 'viewer' },
  [E.APP_OPS_USER]: { pw: E.APP_OPS_PASSWORD, role: 'ops' },
};
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const roleOf = (req) => { if (E.APP_TOKEN && req.headers['x-wingman-token'] === E.APP_TOKEN) return 'viewer'; const m = /sid=(admin|viewer|ops)/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
http.createServer((req, res) => {
  const send = (code, html, h = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...h }); res.end(html); };
  const go = (to, h = {}) => { res.writeHead(302, { location: to, ...h }); res.end(); };
  const form = () => '<form method="post" action="/login" data-testid="login-form"><label for="email">Email</label><input id="email" name="email" type="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Sign in</button></form>';
  const u = new URL(req.url, 'http://x'); const role = roleOf(req);
  if (u.pathname === '/login' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const f = new URLSearchParams(b); const w = users[f.get('email')];
      if (w && w.pw && w.pw === f.get('password')) return go('/dashboard', { 'set-cookie': `sid=${w.role}; Path=/; HttpOnly` });
      send(401, page('Sign in', '<p role="alert">Invalid credentials</p>' + form()));
    });
    return;
  }
  if (u.pathname === '/login') return send(200, page('Sign in', form()));
  if (u.pathname === '/dashboard') {
    if (!role) return go('/login');
    return send(200, page('Dashboard', `<p data-testid="welcome">Welcome, ${role}</p>` + (role === 'admin' ? '<a data-testid="admin-link" href="/admin">Admin</a>' : '')));
  }
  if (u.pathname === '/admin') {
    if (!role) return go('/login');
    if (role !== 'admin') return go('/dashboard');
    return send(200, page('Admin', '<section data-testid="admin-panel"><p>Users: 3</p></section>'));
  }
  send(404, page('Not found', '<p>Nothing here.</p>'));
}).listen(+process.argv[2], '127.0.0.1');
