export const guardComponentKeys=['tables','files','networkRules','networkRoutes','networkDns','networkDomains'] as const;
export type GuardComponent=typeof guardComponentKeys[number];
export type GuardStage='before-inspection'|'probe'|'after-inspection'|'activation'|'active-inspection'|'renewal'|'access-inspection'|'session-state';
export type GuardReason='inspection-failed'|'probe-failed'|'receipts-invalid'|'activation-failed'|'renewal-failed'|'session-retired'|'invalid-digest'|'integrity-changed'|'lease-already-active'|'lease-inactive'|'lease-range';
export interface GuardObservation {leaseActive:boolean;remainingMs:number;digestMatches:boolean;changedComponents?:GuardComponent[]}
export const transportFailureCodes=['FORWARD_CONNECT_FAILED','FORWARD_CONNECT_REFUSED','FORWARD_CONNECT_TIMEOUT','FORWARD_ADMIN_DENIED','TRANSPORT_RESET','TRANSPORT_BROKEN_PIPE','TRANSPORT_TIMEOUT','CONTROL_PIPE_ERROR','PROCESS_ERROR'] as const;
export type TransportFailureCode=typeof transportFailureCodes[number];
export const guestProxyFailureCodes=['RESET','BROKEN_PIPE','REFUSED','TIMEOUT','TLS','DNS'] as const;
export type GuestProxyFailureCode=typeof guestProxyFailureCodes[number];
export interface GuestProxyDiagnostics {state:'following'|'unavailable';failures:Partial<Record<GuestProxyFailureCode,number>>;lastFailureAt?:string}
export const guestProxyFailureLabels:Record<GuestProxyFailureCode,string>={RESET:'连接被重置',BROKEN_PIPE:'连接管道断开',REFUSED:'连接被拒绝',TIMEOUT:'连接超时',TLS:'TLS 错误',DNS:'DNS 错误'};
export interface GuardTransportDiagnostics {state:'starting'|'ready'|'exited'|'spawn-failed';failures:Partial<Record<TransportFailureCode,number>>;lastFailure?:TransportFailureCode;lastFailureAt?:string;exitCode?:number;exitAt?:string;ignoredLines:number;oversizedLines:number;guestProxy?:GuestProxyDiagnostics}
export const transportStateLabels:Record<GuardTransportDiagnostics['state'],string>={starting:'转发进程正在启动',ready:'转发进程曾就绪（不代表所有连接成功）',exited:'转发进程已退出','spawn-failed':'转发进程未能启动'};
export const transportFailureLabels:Record<TransportFailureCode,string>={FORWARD_CONNECT_FAILED:'转发连接失败',FORWARD_CONNECT_REFUSED:'转发目标拒绝连接',FORWARD_CONNECT_TIMEOUT:'转发目标连接超时',FORWARD_ADMIN_DENIED:'转发请求被拒绝',TRANSPORT_RESET:'转发通道连接重置',TRANSPORT_BROKEN_PIPE:'转发通道已断开',TRANSPORT_TIMEOUT:'转发通道无响应',CONTROL_PIPE_ERROR:'转发控制管道出错',PROCESS_ERROR:'转发进程报告错误'};
export interface GuardDiagnostics {
 operation:'open'|'tick'|'access'|'monitor';stage:GuardStage;reason:GuardReason;verifiedReceiptCount:number;
 failureSource?:'vm-inspection'|'guest-inspection'|'guard-response';
 durations:Partial<Record<'beforeInspectMs'|'probeMs'|'afterInspectMs'|'activateMs'|'activeInspectMs'|'renewMs'|'accessInspectMs',number>>;
 before?:GuardObservation;after?:GuardObservation;active?:GuardObservation;access?:GuardObservation;failureCode?:GuardFailureCode;transport?:GuardTransportDiagnostics;
}
export const guardStageLabels:Record<GuardStage,string>={'before-inspection':'核验前检查',probe:'出口检测','after-inspection':'核验后检查',activation:'发放联网许可','active-inspection':'发放后检查',renewal:'续期联网许可','access-inspection':'访问前检查','session-state':'管理会话状态检查'};
export const guardFailureSourceLabels:Record<NonNullable<GuardDiagnostics['failureSource']>,string>={'vm-inspection':'宿主虚拟机状态检查','guest-inspection':'沙箱内防护检查命令','guard-response':'沙箱防护检查结果解析'};
export const guardReasonLabels:Record<GuardReason,string>={'inspection-failed':'防护检查命令未完成','probe-failed':'出口检测未完成','receipts-invalid':'未取得足够一致回执','activation-failed':'联网许可发放失败','renewal-failed':'联网许可续期失败','session-retired':'本次管理会话已结束','invalid-digest':'防护摘要格式无效','integrity-changed':'防护摘要发生变化','lease-already-active':'启动核验时许可未关闭','lease-inactive':'检查时联网许可无效','lease-range':'联网许可余量超出范围'};
export const guardComponentLabels:Record<GuardComponent,string>={tables:'防火墙规则',files:'受管配置文件',networkRules:'路由策略',networkRoutes:'路由表',networkDns:'DNS 配置',networkDomains:'DNS 路由域'};

export const guardFailureCodes=['TIMEOUT','PROCESS_FAILED','PROCESS_INPUT_CLOSED','PROCESS_OUTPUT_TOO_LARGE','PROCESS_OUTPUT_HANDLER_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE','CANCELLED','INVALID_GUARD_RESPONSE'] as const;
export type GuardFailureCode=typeof guardFailureCodes[number];
export const guardOperationLabels={open:'启动核验',tick:'运行中核验',access:'访问前检查',monitor:'管理会话核对'} as const;
export const guardFailureCodeLabels:Record<GuardFailureCode,string>={TIMEOUT:'检查命令超时',PROCESS_FAILED:'检查命令异常退出',PROCESS_INPUT_CLOSED:'检查命令连接关闭',PROCESS_OUTPUT_TOO_LARGE:'检查结果超出限制',PROCESS_OUTPUT_HANDLER_FAILED:'检查输出处理失败',BROKER_TIMEOUT:'权限代理响应超时',BROKER_UNAVAILABLE:'权限代理连接关闭',CANCELLED:'检查已取消',INVALID_GUARD_RESPONSE:'防护检查结果格式无效'};
