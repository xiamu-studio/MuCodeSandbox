import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../server/process.ts';
import { VERSION } from '../shared/version.ts';
import { pathToFileURL } from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const app=path.resolve(process.env.MU_VERIFY_APP??path.join(root,'release/candidate/mac-arm64/MuCodeSandbox.app'));
const temporary=await mkdtemp(path.join(tmpdir(),'mu-package-verification-'));
const report:Record<string,unknown>={passed:false,app,startedAt:new Date().toISOString(),scope:'Local ad-hoc bundle integrity; not Apple notarization or Network Extension authorization'};
try{
  const info=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],{timeoutMs:10_000}));
  assert.equal(info.CFBundleShortVersionString,VERSION);
  report.version=info.CFBundleShortVersionString;
  const appRoot=path.join(app,'Contents/Resources/app');
  const labModule=pathToFileURL(path.join(appRoot,'dist-server/server/acceptance-lab.js')).href;
  const dependencyProbe=`
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    (async () => {
      const { createAcceptanceLab } = await import(${JSON.stringify(labModule)});
      const requireApp = createRequire(${JSON.stringify(path.join(appRoot,'package.json'))});
      const { networkSchema, proxyUrl } = await import(${JSON.stringify(pathToFileURL(path.join(appRoot,'dist-server/server/validation.js')).href)});
      const { wireguardPublicKey } = await import(${JSON.stringify(pathToFileURL(path.join(appRoot,'dist-server/server/wireguard.js')).href)});
      const { wireguardDnsConfig, wireguardFiles } = await import(${JSON.stringify(pathToFileURL(path.join(appRoot,'dist-server/server/wireguard-network.js')).href)});
      const crypto = require('node:crypto');
      const privateKey = crypto.randomBytes(32).toString('base64');
      const peerPublicKey = wireguardPublicKey(crypto.randomBytes(32).toString('base64'));
      const network = networkSchema.parse({ mode: 'wireguard', host: '192.0.2.1', port: 51820, strict: true, transparent: true, wireguard: { address: '10.77.0.2/32', privateKey, peerPublicKey } });
      assert.equal(proxyUrl(network), '');
      const packetEnvironment = { kind: 'vm', network };
      assert.equal(wireguardDnsConfig(packetEnvironment).outbounds[0].bind_interface, 'mu_wg');
      assert.ok(wireguardFiles(packetEnvironment)['/etc/mucodesandbox/wireguard.conf'].includes(privateKey));
      console.log('MU_PACKAGED_PACKET_CONFIG_OK');
      const { Manager } = await import(${JSON.stringify(pathToFileURL(path.join(appRoot,'dist-server/server/manager.js')).href)});
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const backupRoot = ${JSON.stringify(path.join(temporary,'backup-roundtrip'))};
      const source = new Manager(path.join(backupRoot, 'source'));
      const destination = new Manager(path.join(backupRoot, 'destination'));
      try {
        source.runtime.list = async () => source.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
        const created = await source.create({ name: 'Packaged backup', cpus: 1, memoryGiB: 2, diskGiB: 10, ports: [{ id: crypto.randomUUID(), guestPort: 3000, hostPort: 4000 }], network: { mode: 'http', host: 'proxy.test', password: 'synthetic-packaged-proxy-secret' } });
        source.store.state(created.id, 'stopped');
        const environment = source.store.get(created.id);
        const instance = path.join(source.runtime.limaHome, environment.instanceName);
        await fs.mkdir(instance, { recursive: true });
        const disk = await fs.open(path.join(instance, 'disk'), 'wx', 0o600);
        try { await disk.writeFile('MU_PACKAGED_GUEST_DATA'); await disk.truncate(8 * 2 ** 20); } finally { await disk.close(); }
        await source.snapshots.create(environment, 'Packaged backup');
        const [snapshot] = await source.snapshots.list(environment);
        const file = path.join(backupRoot, 'portable.mu-backup');
        const password = 'synthetic-packaged-backup-password';
        await source.backups.export(environment, snapshot.id, file, password);
        const encrypted = await fs.readFile(file);
        assert.ok(!encrypted.includes(Buffer.from('synthetic-packaged-proxy-secret')));
        await assert.rejects(destination.backups.import(file, 'synthetic-wrong-password', 'Wrong'), /密码错误|损坏/);
        assert.deepEqual(destination.store.list(), []);
        const imported = await destination.backups.import(file, password, 'Packaged imported');
        assert.notEqual(imported.id, environment.id);
        assert.notDeepEqual(source.store.key, destination.store.key);
        assert.equal(imported.network.password, environment.network.password);
        assert.deepEqual(imported.ports, []);
        const seed = await fs.open(path.join(destination.store.dataDir, 'imports', imported.id, 'disk'), 'r');
        try { const head = Buffer.alloc(22); await seed.read(head, 0, head.length, 0); assert.equal(head.toString(), 'MU_PACKAGED_GUEST_DATA'); } finally { await seed.close(); }
        console.log('MU_PACKAGED_BACKUP_ROUNDTRIP_OK');
      } finally { await source.close(); await destination.close(); }
      const stun = requireApp('stun');
      const lab = await createAcceptanceLab();
      try {
        const response = await stun.request('127.0.0.1:' + lab.info().stunPort);
        assert.equal(response.getXorAddress().address, '127.0.0.1');
        assert.ok(lab.events.some(event => event.kind === 'stun'));
        console.log('MU_PACKAGED_STUN_OK');
        const messages = await fetch(new URL('/v1/messages', lab.info().url), {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'mu-lab-no-account' },
          body: JSON.stringify({ model: 'mu-fixture', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'MU_LAB_CLAUDE_TEXT' }] }),
        });
        assert.equal(messages.status, 200);
        const stream = await messages.text();
        const events = stream.split('\\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        const text = events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta').map(event => event.delta.text).join('');
        assert.equal(text, 'MU_REAL_CLAUDE_TEXT_OK');
        assert.equal(events.at(-1).type, 'message_stop');
        console.log('MU_PACKAGED_MESSAGES_OK');
        const turns = [
          { role: 'user', content: 'MU_LAB_CLAUDE_WRITE' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mu_0', name: 'Write', input: {} }] },
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'toolu_mu_0', is_error: true, content: 'Synthetic user refusal' },
            { type: 'text', text: 'MU_LAB_CLAUDE_TOOLS' },
          ] },
        ];
        const nextTurn = async () => {
          const response = await fetch(new URL('/v1/messages', lab.info().url), {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'mu-lab-no-account' },
            body: JSON.stringify({ model: 'mu-fixture', messages: turns, tools: ['Write', 'Read', 'Bash'].map(name => ({ name })) }),
          });
          assert.equal(response.status, 200); return response.json();
        };
        for (const name of ['Write', 'Read', 'Bash']) {
          const response = await nextTurn(); assert.equal(response.content[0].name, name);
          assert.ok(lab.messages.at(-1).toolResults.every(result => !result.error));
          turns.push({ role: 'assistant', content: response.content });
          turns.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: response.content[0].id, content: 'Synthetic package tool result' }] });
        }
        assert.equal((await nextTurn()).stop_reason, 'end_turn');
        assert.equal(lab.messages.at(-1).toolResults.length, 3);
        assert.equal(lab.messages.at(-1).historyToolResults[0].error, true);
        turns.push({ role: 'user', content: 'MU_LAB_CLAUDE_TEXT' });
        assert.equal((await nextTurn()).content[0].text, 'MU_REAL_CLAUDE_TEXT_OK');
        assert.deepEqual(lab.messages.at(-1).toolResults, []);
        console.log('MU_PACKAGED_MESSAGES_MULTITURN_OK');
        for (const stream of [true, false]) {
          const fault = await fetch(new URL('/v1/messages', lab.info().url), {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'mu-lab-no-account' },
            body: JSON.stringify({ model: 'mu-fixture', stream, messages: [{ role: 'user', content: 'MU_LAB_CLAUDE_CUT' }] }),
          });
          assert.equal(fault.status, 200); await assert.rejects(fault.text());
          assert.equal(lab.messages.at(-1).completed, false);
        }
        console.log('MU_PACKAGED_CUT_FALLBACK_BLOCKED');
      } finally { await lab.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const dependencyResult=await run(path.join(app,'Contents/MacOS/MuCodeSandbox'),['-e',dependencyProbe],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeoutMs:15_000,
  });
  assert.match(dependencyResult,/MU_PACKAGED_STUN_OK/);
  assert.match(dependencyResult,/MU_PACKAGED_MESSAGES_OK/);
  assert.match(dependencyResult,/MU_PACKAGED_MESSAGES_MULTITURN_OK/);
  assert.match(dependencyResult,/MU_PACKAGED_PACKET_CONFIG_OK/);
  assert.match(dependencyResult,/MU_PACKAGED_CUT_FALLBACK_BLOCKED/);
  assert.match(dependencyResult,/MU_PACKAGED_BACKUP_ROUNDTRIP_OK/);
  report.packagedDependenciesLoad=true;report.packagedStunPositiveControl=true;
  report.packagedMessagesStream=true;
  report.packagedMessagesMultiTurn=true;
  report.packagedInteractiveClaudeTuiTested=false;
  report.packagedMessagesCutFallbackBlocked=true;
  report.packagedWireguardConfiguration=true;
  report.packagedEncryptedBackupRoundtrip=true;
  report.packagedBackupActualVmTested=false;
  report.wireguardVmWorkflowTestedInThisScript=false;
  const verification=await run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],{timeoutMs:60_000});
  assert.match(verification,/valid on disk/);
  const details=await run('/usr/bin/codesign',['-dv','--verbose=4',app],{timeoutMs:10_000});
  assert.match(details,/Signature=adhoc/);
  assert.match(details,/Sealed Resources version=2/);
  report.signature='adhoc';report.teamIdentifier=details.match(/TeamIdentifier=(.+)/)?.[1];
  report.sealedResources=Number(details.match(/Sealed Resources[^\n]*files=(\d+)/)?.[1]);
  report.cdHash=details.match(/^CDHash=(.+)$/m)?.[1];report.deepStrictVerification=true;
  const copy=path.join(temporary,'MuCodeSandbox.app');
  await run('/bin/cp',['-cR',app,copy],{timeoutMs:120_000});
  await run('/usr/bin/codesign',['--verify','--deep','--strict',copy],{timeoutMs:60_000});
  const resource=path.join(copy,'Contents/Resources/app/dist/index.html');
  await writeFile(resource,(await readFile(resource,'utf8'))+'\n<!-- synthetic tamper positive control -->\n');
  await assert.rejects(run('/usr/bin/codesign',['--verify','--deep','--strict',copy],{timeoutMs:60_000}),/resource|modified|invalid|sealed/i);
  report.modifiedResourceRejected=true;
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeoutMs:60_000});
  report.originalBundleUnchanged=true;report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{
  await rm(temporary,{recursive:true,force:true});
  await mkdir(path.join(root,'test-results'),{recursive:true});
  await writeFile(path.join(root,'test-results/package-integrity.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
