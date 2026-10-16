import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dns from 'dns2';
import { run } from '../server/process.ts';

export async function createDohLocalFixture(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  const serverName = 'mu-controlled-doh.test';
  await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=Mu disposable DNS CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', path.join(directory, 'ca.key'), '-out', path.join(directory, 'ca.crt')]);
  await run('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${serverName}`,
    '-keyout', path.join(directory, 'server.key'), '-out', path.join(directory, 'server.csr')]);
  await writeFile(path.join(directory, 'extensions'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${serverName}\n`, { mode: 0o600 });
  await run('/usr/bin/openssl', ['x509', '-req', '-in', path.join(directory, 'server.csr'), '-CA', path.join(directory, 'ca.crt'), '-CAkey', path.join(directory, 'ca.key'),
    '-CAcreateserial', '-days', '1', '-sha256', '-extfile', path.join(directory, 'extensions'), '-out', path.join(directory, 'server.crt')]);
  const sockets = new Set<Duplex>(), dnsSockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); };
  const queries: { name: string; type: number; answer?: string; rcode: number; at: string }[] = [];
  const requests: { host: string; at: string }[] = [];
  const decisions: { destination: string; allowed: boolean; localOnly: boolean }[] = [];
  const doh = createHttps({ cert: await readFile(path.join(directory, 'server.crt')), key: await readFile(path.join(directory, 'server.key')), minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/dns-query' || req.headers['content-type'] !== 'application/dns-message') { res.writeHead(400).end(); return; }
      const parts: Buffer[] = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 4096) { res.writeHead(413).end(); return; } parts.push(part); }
      const query = dns.Packet.parse(Buffer.concat(parts));
      const response = dns.Packet.createResponseFromRequest(query);
      for (const question of query.questions) {
        const exists = /^[a-z0-9-]+\.mu-domain\.test$/.test(question.name) && !question.name.startsWith('missing-');
        if (!exists) response.header.rcode = dns.Packet.RCODE.NXDOMAIN;
        const answer = exists && question.type === dns.Packet.TYPE.A ? '203.0.113.81' : undefined;
        if (answer) response.answers.push(new dns.Packet.Resource({ name: question.name, type: dns.Packet.TYPE.A, class: dns.Packet.CLASS.IN, ttl: 0, address: answer }));
        queries.push({ name: question.name, type: question.type, answer, rcode: response.header.rcode, at: new Date().toISOString() });
      }
      res.writeHead(200, { 'Content-Type': 'application/dns-message', 'Cache-Control': 'no-store' }).end(response.toBuffer());
    } catch { if (!res.headersSent) res.writeHead(400).end(); else res.destroy(); }
  });
  doh.on('connection', socket => { track(socket); dnsSockets.add(socket); socket.once('close', () => dnsSockets.delete(socket)); });
  await new Promise<void>(resolve => doh.listen(0, '127.0.0.1', resolve));
  const dnsPort = (doh.address() as { port: number }).port;
  const target = createHttp((req, res) => { requests.push({ host: req.headers.host ?? '', at: new Date().toISOString() }); res.end('MU_DOMAIN_OK'); });
  target.on('connection', track); await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as { port: number }).port;
  let localOnly = false;
  const proxy = createHttp((_req, res) => res.writeHead(405).end()); proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:doh-fixture').toString('base64')}`) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    let destination: URL; try { destination = new URL(`http://${req.url}`); } catch { client.destroy(); return; }
    const dnsTarget = destination.hostname === '203.0.113.82' && Number(destination.port || 80) === 443;
    const httpTarget = destination.hostname === '203.0.113.81' && Number(destination.port || 80) === 80;
    const provider = /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(destination.hostname);
    const allowed = dnsTarget || httpTarget || (!localOnly && !provider);
    decisions.push({ destination: req.url!, allowed, localOnly });
    if (!allowed) { client.end('HTTP/1.1 403 Local Fixture Only\r\n\r\n'); return; }
    const remote = connect(dnsTarget ? dnsPort : httpTarget ? targetPort : Number(destination.port || 80), dnsTarget || httpTarget ? '127.0.0.1' : destination.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
    });
    track(remote); remote.on('error', () => client.destroy()); client.on('close', () => remote.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { serverName, ca: await readFile(path.join(directory, 'ca.crt'), 'utf8'), cert: await readFile(path.join(directory, 'server.crt')),
    dnsPort, proxyPort: (proxy.address() as { port: number }).port, queries, requests, decisions,
    restrictToLocal: () => { localOnly = true; for (const socket of sockets) socket.destroy(); },
    setDnsAvailable: async (available: boolean) => {
      if (available) { if (!doh.listening) await new Promise<void>(resolve => doh.listen(dnsPort, '127.0.0.1', resolve)); }
      else { for (const socket of dnsSockets) socket.destroy(); if (doh.listening) await new Promise<void>(resolve => doh.close(() => resolve())); }
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve())),
        doh.listening ? new Promise<void>(resolve => doh.close(() => resolve())) : Promise.resolve()]);
    } };
}
