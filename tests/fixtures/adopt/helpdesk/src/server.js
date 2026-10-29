import http from 'node:http';
import * as orders from './orders.js';

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('x-powered-by', 'helpdesk-dev');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    let m;
    if (req.method === 'POST' && url.pathname === '/orders') {
      let raw = ''; for await (const c of req) raw += c;
      const r = orders.place(JSON.parse(raw));
      if (r.error) return json(400, { error: r.error });
      return json(201, { id: r.order.id, totalCents: r.order.totalCents, status: r.order.status });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/orders\/(\d+)$/))) {
      const o = orders.get(m[1]);
      return o ? json(200, o) : json(404, 'nope');
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/orders\/(\d+)\/cancel$/))) {
      const r = orders.cancel(m[1]);
      return r.notFound ? json(404, 'nope') : json(200, { ok: true });
    }
    if (url.pathname === '/debug/dump') return json(200, orders.all());
    json(404, 'nope');
  });
}
