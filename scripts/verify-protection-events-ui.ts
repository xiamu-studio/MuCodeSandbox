import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createService} from '../server/service.ts';
const root=path.resolve(import.meta.dirname,'..'),temporary=await mkdtemp(path.join(tmpdir(),'mu-protection-ui-')),results=path.join(root,'test-results/protection-events');await mkdir(results,{recursive:true});
const service=await createService({rootDir:root,dataDir:temporary,port:0});clearInterval(service.manager.protectionTimer);await service.manager.networkObserver.close();service.manager.runtime.info=async()=>({available:false,path:null,version:null,error:null});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1320,height:1000},deviceScaleFactor:2});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const report:any={passed:false,scope:'Temporary UI and synthetic incident / recovery proof, no VM, accounts, credentials or production changes'};
try{
 const e=await service.manager.create({name:'故障恢复验证',network:{mode:'socks5',host:'127.0.0.1',port:24898,password:'MU_FAKE_PRIVATE_PROXY',strict:true,transparent:true,egressLock:{expectedIp:'203.0.113.8'}}});service.manager.store.state(e.id,'error','环境已停止：不足两个独立出口回执');
 const event={id:randomUUID(),environmentId:e.id,at:new Date().toISOString(),kind:'exit-unavailable' as const,issue:'不足两个独立出口回执',source:'current' as const,route:{mode:'socks5',host:'127.0.0.1',port:24898},expectedIp:'203.0.113.8',observedIps:['203.0.113.8'],checks:[{receiver:'ipwho' as const,status:'success' as const,ip:'203.0.113.8',latencyMs:150},{receiver:'ipify' as const,status:'timeout' as const,latencyMs:12000},{receiver:'icanhazip' as const,status:'pending' as const}],stopResult:'confirmed' as const,resolvedAt:null};service.manager.store.addProtectionEvent(event);
 let retries=0,retryJob='';service.manager.lifecycle=async(id,action)=>{assert.equal(id,e.id);assert.equal(action,'start');retries++;service.manager.store.state(id,'starting');const job=service.manager.store.newJob(id,action);retryJob=job.id;return job;};
 await page.goto(service.launchUrl());await page.getByRole('button',{name:'故障恢复验证 Linux 沙箱'}).click();await page.getByRole('heading',{name:'断网保护',exact:true}).waitFor();await expect(page.getByText('未能取得至少两处一致的出口检测结果，已触发保护。',{exact:true})).toBeVisible();await expect(page.getByText('批准出口 IP',{exact:true})).not.toBeVisible();
 await page.locator('.protection-event-card.compact summary').filter({hasText:'技术详情'}).click();await page.getByRole('heading',{name:'如何修复',exact:true}).waitFor();await page.getByText('HTTPS请求超时',{exact:true}).waitFor();await page.getByText('未完成',{exact:true}).waitFor();
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载这次诊断',exact:true}).click();const download=await downloadEvent;const file=await download.path();const diagnostic=JSON.parse(await readFile(file!,'utf8'));assert.equal(diagnostic.event.expectedIp,'203.0.113.8');assert.equal(diagnostic.event.checks[2].status,'pending');assert.ok(!JSON.stringify(diagnostic).includes('MU_FAKE_PRIVATE_PROXY'));
 for(const width of [1320,800,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(results,`fault-${width}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));}
 await page.setViewportSize({width:1320,height:1000});await page.getByRole('button',{name:'启动环境',exact:true}).click();await page.getByText(/已提交恢复检查/).waitFor();assert.equal(retries,1);assert.equal(service.manager.store.get(e.id).network.egressLock?.expectedIp,'203.0.113.8');assert.equal(service.manager.store.protectionEvents(e.id)[0].resolvedAt,null,'Submitting a retry is not proof of recovery');
 await expect(page.locator('.operation-banner .spin')).toHaveCount(1);await expect(page.locator('.environment-header-actions .spin,.protection-event-card .spin')).toHaveCount(0);await expect(page.locator('.environment-toggle')).toBeDisabled();await expect(page.locator('.protection-event-card.compact').getByRole('button',{name:'启动中',exact:true})).toBeDisabled();await page.screenshot({path:path.join(results,'single-start-progress.png'),fullPage:true});
 service.manager.store.finishJob(retryJob,'failed','fixture retry failed');service.manager.store.state(e.id,'error','恢复检查未通过');await expect(page.getByText(/已提交恢复检查/)).toHaveCount(0,{timeout:10000});
 await page.getByRole('button',{name:'启动环境',exact:true}).click();await page.getByText(/已提交恢复检查/).waitFor();assert.equal(retries,2);
 service.manager.store.finishJob(retryJob,'succeeded','fixture retry succeeded');
 const ip='203.0.113.8';service.manager.store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip,receipts:[{receiver:'ipwho',ip,latencyMs:1},{receiver:'ipify',ip,latencyMs:2}]});service.manager.store.state(e.id,'running');
 await expect(page.getByRole('heading',{name:'断网保护',exact:true})).toHaveCount(0,{timeout:10000});await page.getByRole('button',{name:'日志',exact:true}).click();await page.getByRole('heading',{name:'断网保护记录',exact:true}).waitFor();await expect(page.locator('.protection-event-card')).toHaveCount(1);await page.getByText(/重新检查通过/).first().waitFor();await page.screenshot({path:path.join(results,'recovered-history.png'),fullPage:true});assert.deepEqual(errors,[]);
 const connection={...event,id:randomUUID(),at:new Date().toISOString(),issue:'无法确认批准的出口：curl: (56) peer reset',checks:[{receiver:'ipwho' as const,status:'success' as const,ip:'203.0.113.8',latencyMs:150},{receiver:'ipify' as const,status:'connection-error' as const,latencyMs:910,diagnostics:{curlExitCode:56,httpStatus:0,tcpConnectMs:10,tlsHandshakeMs:200,firstByteMs:0,totalMs:910}},{receiver:'icanhazip' as const,status:'success' as const,ip:'203.0.113.8',latencyMs:170}]};
 service.manager.store.addProtectionEvent(connection);service.manager.store.state(e.id,'error','环境已停止：'+connection.issue);
 await page.getByRole('button',{name:'总览',exact:true}).click();await page.getByText('出口检测连接中断，无法确认当前出口。',{exact:true}).waitFor();await expect(page.getByText(/已提交恢复检查/)).toHaveCount(0);await expect(page.locator('.protection-event-card.compact details')).not.toHaveAttribute('open','');
 await expect(page.getByText('未能取得至少两处一致的出口检测结果，已触发保护。',{exact:true})).toHaveCount(0);await page.locator('.protection-event-card.compact summary').filter({hasText:'技术详情'}).click();await page.getByText(/TLS 握手已完成，未收到 HTTP 状态 · curl 56/).waitFor();
 const connectionDownloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载这次诊断',exact:true}).click();const connectionFile=await(await connectionDownloadEvent).path();const connectionDiagnostic=JSON.parse(await readFile(connectionFile!,'utf8'));
 assert.equal(connectionDiagnostic.event.kind,'exit-unavailable','Historical stored evidence is not rewritten');assert.equal(connectionDiagnostic.displayKind,'connection');assert.equal(connectionDiagnostic.event.checks[1].diagnostics.curlExitCode,56);
 for(const width of [1320,800,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(results,`connection-${width}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));}
 await page.setViewportSize({width:1320,height:1000});
 let failReads=true;
 await page.route(`**/api/environments/${e.id}/protection-events`,route=>failReads?route.fulfill({status:503,json:{error:'MU_SYNTHETIC_HISTORY_READ_FAILURE'}}):route.continue());
 await expect(page.getByText(/MU_SYNTHETIC_HISTORY_READ_FAILURE/)).toBeVisible({timeout:10000});
 failReads=false;
 await expect(page.getByText(/MU_SYNTHETIC_HISTORY_READ_FAILURE/)).toHaveCount(0,{timeout:10000});
 await expect(page.getByRole('heading',{name:'断网保护',exact:true})).toBeVisible();

 // Running state must not resurrect an older unresolved incident. It remains
 // inspectable in history and is never marked as resolved by the renderer.
 service.manager.store.state(e.id,'running');
 await expect(page.locator('.protection-event-card.compact')).toHaveCount(0,{timeout:10000});
 assert.equal(service.manager.store.protectionEvents(e.id)[0].resolvedAt,null);
 service.manager.store.state(e.id,'error','电脑休眠');
 const sleep={...event,id:randomUUID(),at:new Date().toISOString(),kind:'host' as const,issue:'电脑休眠，保护环境已关闭；唤醒后请手动启动',checks:[],observedIps:[],stopResult:'failed' as const,stopIssue:'隔离停机未能确认完成：操作超时'};
 service.manager.store.addProtectionEvent(sleep);
 await expect(page.getByText('电脑休眠，触发断网保护。',{exact:true})).toBeVisible({timeout:10000});
 await expect(page.locator('.protection-event-next')).toHaveCount(0);await expect(page.locator('.protection-event-issue')).toHaveCount(0);
 await expect(page.locator('.protection-event-card.compact details')).not.toHaveAttribute('open','');
 await expect(page.getByText('没有逐端回执明细；不会用当前 IP 补填过去。',{exact:true})).not.toBeVisible();
 await page.screenshot({path:path.join(results,'sleep-summary.png'),fullPage:true});
 // A newer recovered record takes precedence over older unresolved evidence.
 service.manager.store.resolveProtectionEvents(e.id,{at:new Date().toISOString(),ip:'203.0.113.8',receipts:[{receiver:'ipwho',ip:'203.0.113.8',latencyMs:1},{receiver:'ipify',ip:'203.0.113.8',latencyMs:2}]});
 service.manager.store.addProtectionEvent({...event,id:randomUUID(),at:'2020-01-01T00:00:00.000Z'});
 await expect(page.locator('.protection-event-card.compact')).toHaveCount(0,{timeout:10000});
 assert.ok(service.manager.store.protectionEvents(e.id).some(row=>!row.resolvedAt));
 // Restore a current synthetic fault for the late-retry isolation check below.
 service.manager.store.addProtectionEvent({...event,id:randomUUID(),at:new Date().toISOString()});
 await expect(page.getByRole('heading',{name:'断网保护',exact:true})).toBeVisible({timeout:10000});
 const empty=await service.manager.create({name:'另一空白环境'});service.manager.store.state(empty.id,'stopped');
 let releaseRead!:()=>void;const heldRead=new Promise<void>(resolve=>{releaseRead=resolve;});let emptyFails=true;
 await page.route(`**/api/environments/${empty.id}/protection-events`,async route=>{await heldRead;return emptyFails?route.fulfill({status:503,json:{error:'MU_EMPTY_HISTORY_READ_FAILURE'}}):route.continue();});
 let releaseRetry!:()=>void;const heldRetry=new Promise<void>(resolve=>{releaseRetry=resolve;});
 await page.route(`**/api/environments/${e.id}/protection-events/retry`,async route=>{await heldRetry;return route.fulfill({status:503,json:{error:'MU_OLD_ENV_RETRY_FAILURE'}});});
 await page.getByRole('button',{name:'启动环境',exact:true}).click();
 await page.getByRole('button',{name:'另一空白环境 Linux 沙箱',exact:true}).click();
 await page.getByRole('button',{name:'日志',exact:true}).click();
 await expect(page.getByText('正在读取防护记录…',{exact:true})).toBeVisible();
 await expect(page.getByText('尚无防护停机记录。',{exact:true})).toHaveCount(0);
 const retried=page.waitForResponse(response=>response.url().endsWith('/protection-events/retry'));
 releaseRetry();await retried;releaseRead();
 await expect(page.getByText(/MU_EMPTY_HISTORY_READ_FAILURE/).first()).toBeVisible();
 await expect(page.getByText(/MU_OLD_ENV_RETRY_FAILURE/)).toHaveCount(0);
 await expect(page.getByText('尚无防护停机记录。',{exact:true})).toHaveCount(0);
 emptyFails=false;
 await expect(page.getByText('尚无防护停机记录。',{exact:true})).toBeVisible({timeout:10000});
 await expect(page.getByText(/MU_EMPTY_HISTORY_READ_FAILURE/)).toHaveCount(0);
 assert.deepEqual(errors,[]);
 report.passed=true;report.checks=['Plain sleep reason and wake/start instruction; original unconfirmed-stop evidence stays in folded details','Running state hides old incident without rewriting history','Newer recovered incident does not resurrect older unresolved history','A recovered history read clears only its read error','Loading and failed reads never claim an empty history; recovery shows the true empty state','A late retry failure from another environment is not shown in the new environment','Failure visible without searching raw logs','Expected and observed IP / partial receipts distinguish timeout from changed exit','Download is credential-free','Controls fit 1320 / 800 / 390px','Retry does not change the approved IP or resolve before proof','Retry notice disappears after failed retry and does not carry over into a new fault','Verified recovery hides the outage card but retains original history','Old connection resets are displayed separately from insufficient quorum without rewriting stored evidence','TLS progress and curl error survive diagnostic export and fit all three widths'];
}catch(error){report.error=(error as Error).stack;report.visibleText=await page.locator('body').innerText().catch(()=>null);await page.screenshot({path:path.join(results,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await service.close();await rm(temporary,{recursive:true,force:true});await writeFile(path.join(results,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
