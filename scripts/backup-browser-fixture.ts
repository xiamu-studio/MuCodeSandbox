import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createService } from '../server/service.ts';

export const BACKUP_BROWSER_OWNER = 'mu-portable-synthetic-account';
export interface BackupBrowserState { cookie: string; documentCookie: string; localStorage: string | null; indexedDB: string | null }
export interface BackupBrowserReceipt {
  before: BackupBrowserState; after: BackupBrowserState;
  identity: { language: string; timezone: string; platform: string };
  protectedAccount: string; error?: string;
}

export function backupBrowserFixture(origin: string) {
  const evidence = { loginRequests: 0, protectedRequests: [] as string[], receipts: [] as BackupBrowserReceipt[] };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/receipt' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; if (body.length > 16_384) request.destroy(); });
      request.on('end', () => { try { evidence.receipts.push(JSON.parse(body)); response.end('ok'); } catch { response.writeHead(400); response.end(); } });
      return;
    }
    if (url.pathname === '/login') {
      evidence.loginRequests++;
      response.setHeader('Set-Cookie', `synthetic=${BACKUP_BROWSER_OWNER}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      response.end('ok'); return;
    }
    if (url.pathname === '/cookie') { response.end(request.headers.cookie ?? ''); return; }
    if (url.pathname === '/protected') {
      const cookie = request.headers.cookie ?? '';
      evidence.protectedRequests.push(cookie);
      if (cookie !== `synthetic=${BACKUP_BROWSER_OWNER}`) { response.writeHead(401); response.end('unauthorized'); return; }
      response.end(BACKUP_BROWSER_OWNER); return;
    }
    if (url.pathname !== '/write' && url.pathname !== '/read') { response.end('MU_BACKUP_NETWORK_OK'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><title>Mu backup browser acceptance</title><style>body{font:16px sans-serif;margin:28px;background:#f3f5f6;color:#202827}h1{font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Browser backup acceptance</h1><pre id="result">Checking saved state</pre><script>
    const owner=${JSON.stringify(BACKUP_BROWSER_OWNER)};
    const database=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('mu-backup-browser',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});
    const indexed=async(write)=>{const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('state',write?'readwrite':'readonly');const store=tx.objectStore('state');let value=null;if(write)store.put(owner,'owner');else{const r=store.get('owner');r.onsuccess=()=>{value=r.result??null;};}tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(new Error('IndexedDB transaction aborted'));});}finally{db.close();}};
    const state=async()=>({cookie:await(await fetch('/cookie')).text(),documentCookie:document.cookie,localStorage:localStorage.getItem('mu-backup-owner'),indexedDB:await indexed(false)});
    window.__MU_BACKUP_RESULT__=(async()=>{
      const before=await state();
      if(location.pathname==='/write'){const r=await fetch('/login');if(!r.ok)throw Error('Synthetic login failed');localStorage.setItem('mu-backup-owner',owner);await indexed(true);}
      const protectedResponse=await fetch('/protected');if(!protectedResponse.ok)throw Error('Restored cookie did not authenticate');
      const result={before,after:await state(),protectedAccount:await protectedResponse.text(),identity:{language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,platform:navigator.platform}};
      document.querySelector('#result').textContent=JSON.stringify(result,null,2);await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});return result;
    })().catch(error=>{const result={error:String(error)};document.querySelector('#result').textContent=JSON.stringify(result);return result;});
    </script>`);
  };
  return { evidence, handler };
}

export async function backupBrowserReceipt(service: Awaited<ReturnType<typeof createService>>, id: string) {
  const entry = service.guestBrowser.entries.get(id);
  assert.ok(entry?.ready && entry.tools, 'The actual guest browser must be ready');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const targets = await entry.tools.send('Target.getTargets');
    const page = targets.targetInfos.find((target: { type: string }) => target.type === 'page');
    const session = page && entry.sessions.get(page.targetId);
    if (session) {
      const result: { exceptionDetails?: unknown; result: { value?: BackupBrowserReceipt } } = await entry.tools.send('Runtime.evaluate', { expression: 'window.__MU_BACKUP_RESULT__ ?? null', awaitPromise: true, returnByValue: true }, session);
      assert.equal(result.exceptionDetails, undefined);
      if (result.result.value) {
        const receipt = result.result.value as BackupBrowserReceipt;
        assert.equal(receipt.error, undefined, receipt.error);
        return { receipt, entry, session };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Actual guest browser backup receipt timed out');
}

export function validateBackupBrowser(receipt: BackupBrowserReceipt) {
  assert.deepEqual(receipt.after, { cookie: `synthetic=${BACKUP_BROWSER_OWNER}`, documentCookie: '', localStorage: BACKUP_BROWSER_OWNER, indexedDB: BACKUP_BROWSER_OWNER });
  assert.equal(receipt.protectedAccount, BACKUP_BROWSER_OWNER);
  assert.equal(receipt.identity.language, 'ja-JP');
  assert.equal(receipt.identity.timezone, 'Asia/Tokyo');
  assert.match(receipt.identity.platform, /^Linux /);
}
