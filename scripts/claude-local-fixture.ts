import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createAcceptanceLab } from '../server/acceptance-lab.ts';

export async function createClaudeLocalFixture(options: { browserPort?: number } = {}) {
  if (options.browserPort !== undefined && (!Number.isInteger(options.browserPort) || options.browserPort < 1 || options.browserPort > 65535)) throw new Error('Invalid local browser fixture port');
  const lab = await createAcceptanceLab(), labURL = new URL(lab.info().url);
  const sockets = new Set<Socket>(), decisions: { destination: string; allowed: boolean; localOnly: boolean }[] = [];
  const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  let localOnly = false;
  const relay = createServer((req, res) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: labURL.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: labURL.host } }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res); response.on('aborted', () => res.destroy());
    });
    outgoing.on('error', () => res.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
  });
  relay.on('connection', track);
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const relayPort = (relay.address() as { port: number }).port;
  const proxy = createServer((_req, res) => res.writeHead(405).end()); proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('mu:tui-fixture').toString('base64')}`) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    let target: URL; try { target = new URL(`http://${req.url}`); } catch { client.destroy(); return; }
    const fixture = target.hostname === '203.0.113.80' && Number(target.port || 80) === 80;
    const browserFixture = options.browserPort !== undefined && target.hostname === '203.0.113.81' && Number(target.port || 80) === 80;
    const provider = /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(target.hostname);
    const allowed = fixture || browserFixture || (!localOnly && !provider);
    decisions.push({ destination: req.url!, allowed, localOnly });
    if (!allowed) { client.end('HTTP/1.1 403 Local Fixture Only\r\n\r\n'); return; }
    const remote = connect(fixture ? relayPort : browserFixture ? options.browserPort! : Number(target.port) || 80, fixture || browserFixture ? '127.0.0.1' : target.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
    });
    track(remote); remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy()); client.on('close', () => remote.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const restrictToLocalFixture = () => { localOnly = true; for (const socket of sockets) socket.destroy(); };
  async function close() {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => relay.close(() => resolve())), lab.close()]);
  }
  return { lab, proxyPort, decisions, restrictToLocalFixture, close };
}
