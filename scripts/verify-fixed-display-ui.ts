import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { WebSocket, WebSocketServer } from 'ws';
import { displayPixels, displayRequestSchema, type DisplayRequest, type GuestDisplay } from '../shared/guest-display.ts';

// Local fixture only: no application service, VM, real page/account or browser package.
const root = path.resolve(import.meta.dirname, '..');
const results = path.join(root, 'test-results', 'fixed-display');
await mkdir(results, { recursive: true });
const harnessSource = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import GuestBrowserView from '/src/GuestBrowserView.tsx';
    import '/src/styles.css';
    import '/src/liquid.css';
    function Harness(){const [tab,setTab]=React.useState('browser');return <div className="application"><aside className="sidebar">Local fixture</aside><main className="main"><header className="topbar">Local navigation</header><div className="main-content"><section style={{height:230}}>Synthetic environment controls<br/>{['browser','desktop','overview'].map(value=><button key={value} onClick={()=>setTab(value)}>{'fixture-'+value}</button>)}</section><div className="tab-content">{['browser','desktop'].map(value=><div className="retained-page" key={value} hidden={tab!==value}><GuestBrowserView id="fixed-fixture" name={value} embedded desktop={value==='desktop'} active={tab===value}/></div>)}<p style={{height:230}}>Synthetic details below the viewer</p></div></div><footer className="app-footer"><span>Local footer</span><span>Boundary marker</span></footer></main></div>;}
    createRoot(document.getElementById('fixture')).render(React.createElement(Harness));
  `;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins:[{
  name:'viewer-lifecycle-fixture',
  resolveId(id){if(id==='/viewer-lifecycle-entry.tsx')return id;},
  load(id){if(id==='/viewer-lifecycle-entry.tsx')return harnessSource;},
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
    if(req.url!=='/viewer-lifecycle.html')return next();
    try{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><html><body><div id="fixture"></div><script type="module" src="/viewer-lifecycle-entry.tsx"></script></body></html>'));}
    catch(error){next(error);}
  });},
}] });
await vite.listen();
const address = vite.httpServer!.address();
assert.ok(address && typeof address !== 'string');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
const requests: DisplayRequest[] = [], pointers: { x: number; y: number; mask: number }[] = [], errors: string[] = [];
const peers = new Set<WebSocket>();
let tickets = 0;
const unexpectedCalls: string[] = [];
const websocketServer = new WebSocketServer({ noServer: true });
let saved: GuestDisplay | undefined;
let frame = { width: 2560, height: 1600 };
function desktopSize(peer: WebSocket) {
  const message = Buffer.alloc(16);
  message.writeUInt16BE(1, 2); message.writeUInt16BE(frame.width, 8); message.writeUInt16BE(frame.height, 10); message.writeInt32BE(-223, 12);
  peer.send(message);
}
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/guest-browser-ticket')) return route.fulfill({ json: { ticket: `fixture-${++tickets}`, password: 'fixture8' } });
  if (url.pathname.endsWith('/guest-browser/display')) {
    const request = displayRequestSchema.parse(route.request().postDataJSON());
    requests.push(request);
    saved = { ...displayPixels(request), browserScaleFactor: request.scaleFactor, screenWidth: request.cssWidth, screenHeight: request.cssHeight, matched: true };
    frame = { width: saved.width, height: saved.height };
    for (const peer of peers) desktopSize(peer);
    return route.fulfill({ json: saved });
  }
  if (url.pathname.endsWith('/guest-browser')) return route.fulfill({ json: { running: true, ready: true, platform: 'Linux', ...frame, display: saved } });
  if (url.pathname === '/api/snapshot') return route.fulfill({ json: { environments: [{ id: 'fixed-fixture', name: '固定桌面显示夹具' }] } });
  unexpectedCalls.push(`${route.request().method()} ${url.pathname}`);
  return route.fulfill({ status: 404, json: { error: 'Fixture endpoint not provided' } });
});
vite.httpServer!.on('upgrade', (request, socket, head) => {
  if (request.url?.startsWith('/guest-browser?')) websocketServer.handleUpgrade(request, socket, head, peer => websocketServer.emit('connection', peer));
});
websocketServer.on('connection', peer => {
  let buffer = Buffer.alloc(0), stage = 'version', initialized = false;
  peer.send(Buffer.from('RFB 003.008\n'));
  peer.on('close', () => peers.delete(peer));
  peer.on('message', message => {
    buffer = Buffer.concat([buffer, Buffer.from(message as Buffer)]);
    while (buffer.length) {
      if (stage === 'version') {
        if (buffer.length < 12) return;
        buffer = buffer.subarray(12); peer.send(Buffer.from([1, 1])); stage = 'security';
      } else if (stage === 'security') {
        buffer = buffer.subarray(1); peer.send(Buffer.alloc(4)); stage = 'init';
      } else if (stage === 'init') {
        buffer = buffer.subarray(1);
        const name = Buffer.from('Fixed display fixture'), init = Buffer.alloc(24);
        init.writeUInt16BE(frame.width, 0); init.writeUInt16BE(frame.height, 2);
        init[4] = 32; init[5] = 24; init[7] = 1;
        init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
        init[14] = 16; init[15] = 8; init.writeUInt32BE(name.length, 20);
        peer.send(Buffer.concat([init, name])); peers.add(peer); stage = 'messages';
      } else {
        const type = buffer[0];
        let length: number;
        if (type === 0) length = 20;
        else if (type === 2) { if (buffer.length < 4) return; length = 4 + buffer.readUInt16BE(2) * 4; }
        else if (type === 3) length = 10;
        else if (type === 4) length = 8;
        else if (type === 5) length = 6;
        else if (type === 6) { if (buffer.length < 8) return; length = 8 + buffer.readUInt32BE(4); }
        else throw Error(`Unexpected fixture client message ${type}`);
        if (buffer.length < length) return;
        if (type === 3 && !initialized) { initialized = true; desktopSize(peer); }
        if (type === 5) pointers.push({ x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4), mask: buffer[1] });
        buffer = buffer.subarray(length);
      }
    }
  });
});
const geometry = () => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>('.guest-browser-canvas canvas')!;
  const viewport = document.querySelector<HTMLDivElement>('.guest-browser-display')!;
  const bounds = canvas.getBoundingClientRect();
  return { pixels: { width: canvas.width, height: canvas.height }, canvas: { width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top }, viewport: { width: viewport.clientWidth, height: viewport.clientHeight, scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight }, dpr: window.devicePixelRatio };
});
const waitFrame = async (width: number, height: number) => {
  await page.waitForFunction(({ width, height }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.guest-browser-canvas canvas');
    return canvas?.width === width && canvas?.height === height;
  }, { width, height });
};
try {
  await page.goto(`http://127.0.0.1:${address.port}/?guestBrowser=fixed-fixture`);
  await page.locator('.guest-browser-resolution').filter({ hasText: '固定 1600×1000 · 2×' }).waitFor({timeout:10000});
  await waitFrame(3200, 2000);
  assert.equal(requests.length, 1);
  const normal = await geometry();
  assert.ok(normal.canvas.width <= normal.viewport.width + 1 && normal.canvas.height <= normal.viewport.height + 1, 'default view must show the whole desktop');
  assert.ok(normal.viewport.scrollWidth <= normal.viewport.width + 1 && normal.viewport.scrollHeight <= normal.viewport.height + 1, 'default view must not crop right or bottom edges');
  const fitPoint = { x: Math.floor(normal.canvas.left + normal.canvas.width - 16), y: Math.floor(normal.canvas.top + normal.canvas.height - 16) };
  await page.mouse.click(fitPoint.x, fitPoint.y);
  await page.waitForTimeout(100);
  const fitPointer = pointers.findLast(value => value.mask === 1)!;
  assert.ok(fitPointer, 'bottom-right input in fit mode must reach the VNC source');
  assert.ok(Math.abs(fitPointer.x - (fitPoint.x - normal.canvas.left) * normal.pixels.width / normal.canvas.width) <= 2);
  assert.ok(Math.abs(fitPointer.y - (fitPoint.y - normal.canvas.top) * normal.pixels.height / normal.canvas.height) <= 2, JSON.stringify({ fitPointer, fitPoint, normal }));
  await page.screenshot({ path: path.join(results, 'fixed-normal.png') });
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.getByRole('combobox', { name: '画面查看方式', exact: true }).selectOption('native');
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.waitForTimeout(250);
  const native = await geometry();
  assert.equal(native.canvas.width * native.dpr, native.pixels.width);
  assert.equal(native.canvas.height * native.dpr, native.pixels.height);
  assert.ok(native.viewport.scrollWidth > native.viewport.width && native.viewport.scrollHeight > native.viewport.height);
  assert.equal(requests.length, 1, 'native viewing must not change guest desktop');
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(450);
  assert.equal(requests.length, 1, 'ordinary resize must not change a fixed guest desktop');
  await page.evaluate(() => { const view = document.querySelector('.guest-browser-display')!; view.scrollLeft = 140; view.scrollTop = 90; });
  const cropped = await geometry();
  const point = { x: Math.max(80, cropped.canvas.left + 240), y: Math.max(110, cropped.canvas.top + 200) };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(100);
  const pointer = pointers.findLast(value => value.mask === 1)!;
  assert.ok(pointer, 'mouse press must reach the VNC source');
  assert.ok(Math.abs(pointer.x - (point.x - cropped.canvas.left) * cropped.dpr) <= 2);
  assert.ok(Math.abs(pointer.y - (point.y - cropped.canvas.top) * cropped.dpr) <= 2);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.waitForTimeout(450);
  assert.equal(requests.length, 1, 'fullscreen must not change fixed guest desktop');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await page.waitForTimeout(450);
  assert.equal(requests.length, 1);
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.getByRole('combobox', { name: '画面查看方式', exact: true }).selectOption('fit');
  await page.waitForTimeout(250);
  const fit = await geometry();
  assert.ok(fit.canvas.width <= fit.viewport.width + 1 && fit.canvas.height <= fit.viewport.height + 1);
  assert.equal(requests.length, 1, 'viewing options must not change guest desktop');
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.waitForTimeout(450);
  const large = await geometry();
  assert.equal(large.canvas.width, 1600); assert.equal(large.canvas.height, 1000);
  assert.equal(requests.length, 1);
  await page.getByRole('combobox', { name: '固定桌面尺寸', exact: true }).selectOption('1920x1080');
  await waitFrame(3840, 2160);
  await page.locator('.guest-browser-resolution').filter({ hasText: '固定 1920×1080 · 2×' }).waitFor();
  assert.equal(requests.length, 2);
  await page.getByRole('button', { name: '重新连接浏览器画面', exact: true }).click();
  await page.locator('.guest-browser-connection').filter({ hasText: '已连接' }).waitFor();
  await waitFrame(3840, 2160);
  await page.waitForTimeout(450);
  assert.equal(requests.length, 2, 'reconnect must recover the fixed session without resizing');
  assert.equal(await page.getByRole('combobox', { name: '固定桌面尺寸', exact: true }).inputValue(), '1920x1080');
  await page.reload();
  await page.locator('.guest-browser-connection').filter({ hasText: '已连接' }).waitFor();
  await waitFrame(3840, 2160);
  await page.waitForTimeout(450);
  const reopened = await geometry();
  assert.ok(reopened.canvas.width <= reopened.viewport.width + 1 && reopened.canvas.height <= reopened.viewport.height + 1, 'reopening viewer must default to complete display');
  assert.equal(requests.length, 2, 'reopening viewer must preserve the fixed guest desktop');
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'display/audio controls must fit a narrow window');
  assert.equal(requests.length, 2, 'a narrow viewing area still preserves the fixed desktop');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('combobox', { name: '虚拟桌面模式', exact: true }).selectOption('adaptive');
  await page.locator('.guest-browser-resolution').filter({ hasText: '自适应' }).waitFor();
  const adaptiveRequests = requests.length;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(600);
  assert.equal(requests.length, adaptiveRequests + 1, 'adaptive choice intentionally updates the real desktop');
  assert.equal(requests.at(-1)?.mode, 'adaptive');

  // Two retained panels share the guest desktop. Switching tabs must leave
  // only the visible panel updating; hidden viewers retain their sockets and canvases.
  saved={...displayPixels({cssWidth:1920,cssHeight:1080,scaleFactor:2,mode:'fixed'}),browserScaleFactor:2,matched:true};
  frame={width:saved.width,height:saved.height};
  await page.goto(`http://127.0.0.1:${address.port}/viewer-lifecycle.html`);
  const waitPeers = async (count:number) => {
    const deadline=Date.now()+5000;
    while(peers.size!==count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(peers.size,count,'Visited panels retain one RFB connection each');
  };
  await page.locator('.guest-browser-connection:visible').filter({hasText:'已连接'}).waitFor();
  await waitPeers(1);
  const embeddedGeometry=()=>page.locator('.retained-page:not([hidden]) .guest-browser-view').evaluate(element=>{
    const rect=(node:Element)=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
    const canvas=element.querySelector('canvas')!,viewport=element.querySelector('.guest-browser-display')!;
    return {surface:rect(element),canvas:rect(canvas),viewport:rect(viewport),content:rect(document.querySelector('.main-content')!),footer:rect(document.querySelector('.app-footer')!),pixels:{width:canvas.width,height:canvas.height},scrollTop:document.querySelector('.main-content')!.scrollTop};
  });
  const smallWindows=[];
  for(const size of [{width:1320,height:900},{width:1320,height:650},{width:1000,height:600},{width:800,height:560},{width:390,height:700}]){
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    const actual=await embeddedGeometry();smallWindows.push({size,...actual});
    await page.screenshot({path:path.join(results,`embedded-${size.width}x${size.height}.png`)});
    assert.ok(actual.canvas.top>=actual.content.top-1&&actual.canvas.bottom<=actual.content.bottom+1,JSON.stringify({message:'The complete remote canvas must fit the scroll area above the app footer',size,actual}));
    assert.ok(actual.surface.bottom<=actual.footer.top+1,'The viewer must not extend behind the footer');
    assert.ok(actual.canvas.right<=actual.content.right+1&&actual.canvas.left>=actual.content.left-1,'Both horizontal edges must fit');
    assert.deepEqual(actual.pixels,{width:3840,height:2160},'Embedding never changes fixed guest pixels');
    const point={x:actual.canvas.right-8,y:actual.canvas.bottom-8};
    await page.mouse.click(point.x,point.y);await page.waitForTimeout(50);
    const press=pointers.findLast(value=>value.mask===1)!;
    // Browser input coordinates round to CSS pixels. At strong downscaling one
    // such pixel spans several guest pixels; bound error in the rendered view.
    const errorX=Math.abs(press.x-(point.x-actual.canvas.left)*actual.pixels.width/actual.canvas.width)*actual.canvas.width/actual.pixels.width;
    const errorY=Math.abs(press.y-(point.y-actual.canvas.top)*actual.pixels.height/actual.canvas.height)*actual.canvas.height/actual.pixels.height;
    assert.ok(errorX<=2&&errorY<=2,JSON.stringify({message:'Bottom-right input stays aligned within two rendered CSS pixels',size,press,point,errorX,errorY,actual}));
  }
  await writeFile(path.join(results,'embedded-small-windows.json'),JSON.stringify({passed:true,smallWindows},null,2));
  await page.setViewportSize({width:1100,height:800});
  await page.locator('.main-content').evaluate(node=>node.scrollTop=0);
  const retainedTickets=tickets;
  for(let cycle=0;cycle<3;cycle++){
    await page.getByRole('button',{name:'fixture-overview',exact:true}).click();
    await waitPeers(cycle===0?1:2);
    assert.equal(await page.locator('.guest-browser-canvas canvas').count(),cycle===0?1:2,'Hidden panels retain backing canvases');
    await page.getByRole('button',{name:cycle%2?'fixture-browser':'fixture-desktop',exact:true}).click();
    await page.locator('.guest-browser-connection:visible').filter({hasText:'已连接'}).waitFor();
    await waitPeers(2);
  }
  assert.equal(tickets,retainedTickets+1,'Only the first desktop visit obtains a ticket');
  assert.deepEqual(unexpectedCalls,[],'Switching viewers must not stop/reset guest apps or clear their profiles');
  assert.deepEqual(errors, []);
  const report = { passed: true, fixtureOnly: true, checked: ['default fixed DPR 2 with complete fit view', 'fit bottom-right input coordinates', 'native source/host pixel mapping', 'ordinary resize/fullscreen/exit leaves desktop unchanged', 'scroll/crop input coordinates', 'fit does not upscale', 'selection changes real desktop request', 'reconnect restores session choice', 'reopened viewer stays complete', 'explicit adaptive mode', 'hidden retained views keep connections and canvases', 'tab resume reuses authenticated connection without lifecycle mutation'], normal, native, cropped, fit, large, reopened, requests, mousePress: pointer, fitMousePress: fitPointer, errors };
  await writeFile(path.join(results, 'ui.json'), JSON.stringify(report, null, 2));
  await rm(path.join(results, 'ui-failure.json'), { force: true });
  console.log(JSON.stringify({ passed: true, requests: requests.length, report: path.join(results, 'ui.json') }));
} catch (error) {
  await writeFile(path.join(results, 'ui-failure.json'), JSON.stringify({ error: String(error), errors, requests, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally {
  await browser.close();
  for (const peer of peers) peer.terminate();
  await new Promise<void>(resolve => websocketServer.close(() => resolve()));
  await vite.close();
}
