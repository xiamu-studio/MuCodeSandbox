import { randomUUID } from 'node:crypto';
import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Manager } from './manager.ts';
import type { GuestBrowserHost } from './guest-browser.ts';
import type { LocalCheckReport } from '../shared/types.ts';
import { createAcceptanceLab } from './acceptance-lab.ts';
import { ProxyTransports } from './proxy-transport.ts';
import { AppError, errorMessage } from './errors.ts';

export class LocalChecks {
  reports = new Map<string,LocalCheckReport>();
  private manager:Manager;
  private browser:GuestBrowserHost;
  constructor(manager:Manager, browser:GuestBrowserHost) {this.manager=manager;this.browser=browser;}
  async restore(){
    const directory=path.join(this.manager.store.dataDir,'local-checks');
    const files=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    const schema=z.object({id:z.uuid(),environmentId:z.uuid(),environmentName:z.string().max(60),checkedAt:z.iso.datetime(),
      state:z.enum(['passed','failed','running']),accountFree:z.literal(true),paidModelCalls:z.literal(0),scope:z.string().max(500),
      checks:z.array(z.object({name:z.string().max(100),passed:z.boolean(),detail:z.string().max(1000)}).strict()).max(10),error:z.string().max(4000).optional()}).strict();
    for(const file of files.filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).sort().slice(-50)){
      try{const bytes=await readFile(path.join(directory,file));if(bytes.length>32768)continue;const r=schema.parse(JSON.parse(bytes.toString()));
        if(`${r.id}.json`!==file||!this.manager.store.list().some(e=>e.id===r.environmentId))continue;
        if(r.state==='running'){r.state='failed';r.error='应用退出时检测未完成，请重新运行';}
        const previous=this.reports.get(r.environmentId);
        if(!previous||Date.parse(r.checkedAt)>Date.parse(previous.checkedAt))this.reports.set(r.environmentId,r);
      }catch{/* Invalid records never become a successful result. */}
    }
  }
  start(id:string) {
    const e=this.manager.store.get(id);
    if(e.kind!=='vm'||e.state!=='running'||!e.network.strict||!e.network.transparent)
      throw new AppError('请先启动已配置强制防护的 Linux 沙箱',409,'LAB_PROTECTED_VM_REQUIRED');
    const report:LocalCheckReport={id:randomUUID(),environmentId:e.id,environmentName:e.name,checkedAt:new Date().toISOString(),
      state:'running',accountFree:true,paidModelCalls:0,scope:'所选 Linux 沙箱的实时防护与本地浏览器 / 合成登录 / 模拟模型检测；不覆盖公网出口、实际 DNS 或 WebRTC 泄漏',checks:[]};
    const job=this.manager.submit(id,'lab-check',async options=>{
      this.reports.set(id,report);
      if(this.reports.size>50)this.reports.delete(this.reports.keys().next().value!);
      const transport=new ProxyTransports(this.manager.runtime.limaHome);
      let lab:Awaited<ReturnType<typeof createAcceptanceLab>>|undefined;
      try{
        await this.manager.assertAccess(id,true);
        const before=await this.manager.runtime.networkProtection(e);
        report.checks.push({name:'实时防护',passed:before.active&&before.integrity==='verified'&&!!before.leaseActive,detail:'防火墙、路由、受控 DNS 与联网许可'});
        lab=await createAcceptanceLab();
        const identity=await transport.open(id,e.instanceName,'127.0.0.1',Number(new URL(lab.info().url).port),options);
        lab.allowLoopbackPort(identity.port);
        const result=await this.browser.localCheck(e,`http://127.0.0.1:${identity.port}/`,options);
        if(!lab.receipts.some(receipt=>receipt.id===result.probe.id))throw new AppError('检测结果缺少本次接收端回执',409,'LAB_RECEIPT_MISSING');
        const matches=result.probe.mismatches;
        report.checks.push({name:'语言与时区',passed:result.identity.matchesConfiguration,detail:`${result.identity.language} · ${result.identity.timezone} · ${result.identity.platform}`},
          {name:'页面 / Worker / iframe',passed:Array.isArray(matches)&&matches.length===0,detail:Array.isArray(matches)&&matches.length?`存在差异：${matches.join('、')}`:'实际上下文特征比较'},
          {name:'合成登录',passed:result.simulated?.account==='synthetic-a',detail:'仅使用本地虚构账户，未登录真实服务'},
          {name:'模拟模型流',passed:result.simulated?.streamFinished===true,detail:'本地 Messages 流完成，付费模型请求为 0'});
        await this.manager.assertAccess(id,true);
        const after=await this.manager.runtime.networkProtection(e);
        report.checks.push({name:'检测后防护',passed:after.active&&after.integrity==='verified'&&after.firewallHash===before.firewallHash,detail:'检测后复核，规则不变'});
        if(report.checks.some(check=>!check.passed))throw new AppError('部分本地检测未通过，请查看分项结果',409,'LAB_CHECK_FAILED');
        report.state='passed';
      }catch(error){report.state='failed';report.error=errorMessage(error);throw error;}
      finally{
        await transport.close(id);await lab?.close();report.checkedAt=new Date().toISOString();
        const directory=path.join(this.manager.store.dataDir,'local-checks');await mkdir(directory,{recursive:true,mode:0o700});
        await writeFile(path.join(directory,`${report.id}.json`),JSON.stringify(report,null,2),{mode:0o600});
        this.manager.store.log(id,null,`无账号检测：${report.state}，${report.checks.filter(c=>c.passed).length}/${report.checks.length} 项。仅本地限定范围。`);
      }
    });
    return job;
  }
}
