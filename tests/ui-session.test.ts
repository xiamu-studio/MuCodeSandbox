import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request } from 'express';
import { createUISession } from '../server/ui-session.ts';

test('UI bootstrap requires a private launch or session cookie even through a local proxy', async () => {
  const app = express();
  let origin = '';
  const ui = createUISession({ allowedOrigin: value => !value || value === origin });
  app.use(ui.middleware);
  app.get('/', (request, response) => {
    assert.equal(ui.isAuthorized(request), true);
    response.type('html').send('<script>window.__MU_CONFIG__={token:"test-control-token"}</script>');
  });
  app.get('/assets/example.js', (_request, response) => response.type('js').send('/* static */'));
  app.get('/api/example', (_request, response) => response.json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const proxy = createServer((request, response) => {
    const target = new URL(request.url!);
    const outgoing = httpRequest(target, { headers: { host: target.host } }, result => {
      response.writeHead(result.statusCode!, result.headers);
      result.pipe(response);
    });
    outgoing.on('error', () => { response.writeHead(502); response.end(); });
    outgoing.end();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const plain = await fetch(origin);
    assert.equal(plain.status, 403);
    assert.ok(!(await plain.text()).includes('test-control-token'));
    assert.equal(plain.headers.get('set-cookie'), null);

    const proxied = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      httpRequest({ hostname: '127.0.0.1', port: (proxy.address() as AddressInfo).port, path: `${origin}/` }, (response: IncomingMessage) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', value => { text += value; });
        response.on('end', () => resolve({ status: response.statusCode!, text }));
      }).on('error', reject).end();
    });
    assert.equal(proxied.status, 403);
    assert.ok(!proxied.text.includes('test-control-token'));
    assert.equal((await fetch(`${origin}/assets/example.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/example`)).status, 200);

    const launch = ui.launchUrl(origin, '/?guestBrowser=guest-id&browser=browser-id&other=value');
    const authorized = await fetch(launch, { redirect: 'manual' });
    assert.equal(authorized.status, 302);
    assert.equal(authorized.headers.get('location'), '/?guestBrowser=guest-id&browser=browser-id&other=value');
    assert.equal(authorized.headers.get('cache-control'), 'no-store');
    assert.equal(authorized.headers.get('referrer-policy'), 'no-referrer');
    const setCookie = authorized.headers.get('set-cookie')!;
    assert.match(setCookie, /^mu_ui_[a-f0-9]{16}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.ok(!/Domain=/i.test(setCookie));
    const cookie = setCookie.split(';')[0];
    const homepage = await fetch(`${origin}${authorized.headers.get('location')}`, { headers: { Cookie: cookie } });
    assert.equal(homepage.status, 200);
    assert.ok((await homepage.text()).includes('test-control-token'));
    assert.equal((await fetch(ui.launchUrl(origin, '/?guestBrowser=another'), { redirect: 'manual' })).status, 302);

    const wrong = new URL(launch);
    wrong.searchParams.set('launch', 'incorrect');
    const wrongResponse = await fetch(wrong, { redirect: 'manual' });
    assert.equal(wrongResponse.status, 403);
    assert.equal(wrongResponse.headers.get('set-cookie'), null);
    assert.equal((await fetch(`${launch}&launch=duplicate`, { redirect: 'manual' })).status, 403);
    assert.equal((await fetch(launch, { method: 'POST', redirect: 'manual' })).status, 403);
    assert.equal((await fetch(launch, { headers: { Origin: 'https://remote.example' }, redirect: 'manual' })).status, 403);
    assert.equal((await fetch(origin, { headers: { Cookie: cookie, Origin: 'https://remote.example' } })).status, 403);
    assert.equal((await fetch(origin, { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 403);
    assert.equal((await fetch(origin, { headers: { Cookie: `${cookie}x` } })).status, 403);
    const mutated = `${cookie.slice(0, -1)}${cookie.endsWith('x') ? 'y' : 'x'}`;
    assert.equal((await fetch(origin, { headers: { Cookie: mutated } })).status, 403);
    const otherInstance = createUISession({ allowedOrigin: value => !value || value === origin });
    assert.equal(otherInstance.isAuthorized({ headers: { cookie } } as Request), false);

    assert.throws(() => ui.launchUrl('http://remote.example'), /local UI origin/);
    assert.throws(() => ui.launchUrl(origin, '//remote.example/'), /local UI path/);
    assert.throws(() => ui.launchUrl(origin, '/#secret'), /local UI path/);
  } finally {
    proxy.closeAllConnections(); server.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('UI session credentials are independent across service instances', async () => {
  const first = createUISession({ allowedOrigin: value => !value });
  const second = createUISession({ allowedOrigin: value => !value });
  assert.notEqual(first.launchUrl('http://127.0.0.1:1'), second.launchUrl('http://127.0.0.1:1'));
});
