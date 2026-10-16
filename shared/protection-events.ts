import type {EgressCheck,EgressVerification} from './types.ts';
export type ProtectionKind='exit-changed'|'exit-unavailable'|'connection'|'tls'|'proxy-auth'|'dns'|'lease'|'integrity'|'host'|'unknown';
export interface ProtectionResolution {at:string;ip?:string;receipts:EgressVerification['receipts']}
export interface ProtectionEvent {
 id:string;environmentId:string;at:string;kind:ProtectionKind;issue:string;source:'current'|'legacy';
 route:{mode:string;host:string;port:number};expectedIp?:string;observedIps:string[];checks:EgressCheck[];
 stopResult:'requested'|'confirmed'|'failed'|'not-confirmed';stopIssue?:string;
 resolvedAt:string|null;resolution?:ProtectionResolution;
 persisted?:boolean;
}
export const protectionLabels:Record<ProtectionKind,string>={'exit-changed':'检测到出口 IP 变化','exit-unavailable':'未取得足够出口回执',connection:'出口核验连接中断',tls:'HTTPS证书或安全连接失败','proxy-auth':'代理认证失败',dns:'域名解析失败',lease:'自动断网许可失效',integrity:'隔离或防火墙检查失败',host:'本机网络或电源状态变化',unknown:'防护检查失败'};
export const checkLabels:Record<EgressCheck['status'],string>={pending:'未完成',success:'收到回执',timeout:'HTTPS请求超时','command-timeout':'管理命令超时','tls-error':'安全连接失败','auth-error':'代理认证失败','dns-error':'域名解析失败','connection-error':'连接失败','invalid-response':'回执格式无效',cancelled:'检查中断'};
export function protectionKind(issue:string,checks:EgressCheck[]=[]):ProtectionKind{
 if(/出口.*(?:已变化|不一致|不同)/.test(issue))return 'exit-changed';
 if(checks.some(c=>c.status==='tls-error')||/证书|TLS|SSL/.test(issue))return 'tls';
 if(checks.some(c=>c.status==='auth-error')||/认证|407/.test(issue))return 'proxy-auth';
 if(checks.some(c=>c.status==='dns-error')||/域名解析失败/.test(issue))return 'dns';
 if(checks.some(c=>c.status==='connection-error')||/curl:\s*\((7|52|56|97)\)/.test(issue))return 'connection';
 if(/回执|批准的出口/.test(issue))return 'exit-unavailable';
 if(/租约|断网许可|管理会话|代理通道.*关闭/.test(issue))return 'lease';
 if(/电脑.*(?:休眠|唤醒|网络)|宿主.*状态/.test(issue))return 'host';
 if(/保护未通过|隔离|防火墙|网络防护|规则.*核验/.test(issue))return 'integrity';
 return 'unknown';
}
export function protectionDisplayKind(event:ProtectionEvent):ProtectionKind{
 return event.kind==='exit-unavailable'&&protectionKind(event.issue,event.checks)==='connection'?'connection':event.kind;
}
// Describe only evidence that was actually recorded. A failed stop or absent
// receiver result must not be turned into a claim of safety or an IP change.
export function protectionExplanation(event:ProtectionEvent):{reason:string;next:string}{
 const kind=protectionDisplayKind(event);
 let reason: string,next: string;
 if(kind==='host'&&/休眠/.test(event.issue)){reason='电脑休眠，触发断网保护。'+(event.stopResult==='confirmed'?'服务已关闭。':'');next='唤醒后点击“启动环境”继续使用。';}
 else if(kind==='host'){reason='本机网络或电源状态发生变化，沙箱暂停联网。';next='确认本机网络恢复后，点“重新核验并启动”。';}
 else if(kind==='lease'){reason='应用与沙箱的联网保护连接已失效，无法继续确认联网安全。';next='保持应用开启、确认网络可用，再重新核验并启动。';}
 else if(kind==='exit-changed'){reason=`出口 IP 与批准值不同：${event.expectedIp??'未配置'} → ${event.observedIps.join('、')||'详见诊断'}。`;next='检查代理是否换了节点；恢复原线路后重新核验。';}
 else if(kind==='exit-unavailable'){reason='未能取得至少两处一致的出口检测结果，已触发保护。';next='确认 VPS 和本机代理在线，网络恢复后重新核验。';}
 else if(kind==='connection'){reason='出口检测连接中断，无法确认当前出口。';next='检查 VPS 和本机代理连接，恢复后重新核验。';}
 else if(kind==='proxy-auth'){reason='代理账号验证失败，当前线路无法使用。';next='到网络页检查代理用户名、密码或有效期。';}
 else if(kind==='dns'){reason='域名解析失败，出口检测无法完成。';next='到网络页检查 DNS 与代理线路，再重新核验。';}
 else if(kind==='tls'){reason='安全连接检查失败，未通过证书或加密连接验证。';next='检查电脑时间、代理证书和线路配置，再重新核验。';}
 else if(kind==='integrity'){reason='沙箱隔离或网络防护配置未通过检查。';next='查看技术详情中的失败项，修复后重新核验。';}
 else{reason='防护检查未通过，当前原因需要进一步排查。';next='查看技术详情或下载诊断，检查网络与应用状态。';}
 return {reason,next};
}
export function probeProgress(check:EgressCheck):string|null{
 const d=check.diagnostics;if(!d)return null;
 if(d.httpStatus)return `收到 HTTPS 响应 · HTTP ${d.httpStatus}`;
 if(d.tlsHandshakeMs>0)return 'TLS 握手已完成，未收到 HTTP 状态';
 if(d.tcpConnectMs>0)return 'TCP 已连接，远端 TLS 尚未确认';
 return 'TCP / TLS 尚未确认';
}
export function recoverySteps(kind:ProtectionKind):string[]{
 const steps:Record<ProtectionKind,string[]>={
  'exit-changed':['核对下方批准 IP 与实际回执；确认代理是否切换了节点、线路或出口。','先恢复原批准线路。确实要换线路时，到网络页核对新出口后由你修改批准值；系统不会自动接受新 IP。','点“重试核验并启动”。只在当前配置通过全部检查后恢复联网。'],
  'exit-unavailable':['查看哪些检测端超时或没有回执；这不等于已发现另一个 IP。','确认 VPS / 本机代理在线、端口正确；若只有检测站点暂时不可用，稍后重试，不要关闭出口锁定。','点“重试核验并启动”。仍失败会继续断网并留下新的记录。'],
  connection:['查看中断的检测端、错误码和连接阶段；未完成的检测端不代表返回了异常 IP。','确认本机到 VPS 的代理通道仍在线；若只有某个检测端中断，保留诊断后重试。TCP 已连接不等于远端 TLS 或响应已完成，单次记录不能确定是哪一跳故障。','点“重试核验并启动”。仍须通过至少两个独立一致回执和安全检查，连接错误不会被当作普通超时放行。'],
  tls:['核对代理的 TLS 服务名、证书和电脑时间。','修复证书或线路配置；不要忽略证书错误或关闭 HTTPS 校验。','修复后重试核验。'],
  'proxy-auth':['检查网络页代理类型、用户名及密码是否正确或到期。','密码只填在应用网络页；诊断报告不会包含密码。','保存正确配置后重试核验。'],
  dns:['检查网络页受控 DNS 地址、TLS 名称和当前上游可用性。','使用能通过同一批准线路访问的 DNS；不要改成直接发送普通 DNS。','保存配置后重试核验。'],
  lease:['应用退出、休眠或管理连接中断会使许可失效，保存的资料仍在。','先恢复本机网络并保持应用开启。','重试核验并启动，由正常启动流程重新发放短期许可。'],
  integrity:['查看诊断中的隔离 / 防火墙检查失败项。','恢复受管组件和配置；无法确定时保留诊断，不关闭隔离或添加 --no-sandbox。','修复后按正常流程重新核验。'],
  host:['确认电脑已唤醒、本机网络恢复且网络监测正常。','若本机切换了网络或代理，核对当前线路。','手动重试核验，不需要删除环境。'],
  unknown:['下载诊断，保留失败时间、线路和原始原因。','先检查本机网络、代理与应用状态；原因未明确前不要反复重置环境。','修复后再重试核验。'],
 };return steps[kind];
}
