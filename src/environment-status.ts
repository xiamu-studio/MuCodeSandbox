import {WINDOWS_RESOURCE_ERRORS,WINDOWS_OLD_RESOURCE_DISK} from '../shared/windows-resource-errors.ts';
import type { Environment, EgressStatus, NetworkProtection, Job } from '../shared/types.ts';

export type StatusDestination = 'network' | 'browser' | 'desktop' | 'agent' | 'settings' | 'logs' | 'snapshots' | 'bridge' | 'system';
export function freshReading(at: string | undefined, now = Date.now(), lifetime = 45_000) {
  const age = now - Date.parse(at ?? '');
  return Number.isFinite(age) && age >= -1000 && age < lifetime;
}
export function protectionVerified(environment: Environment, protection: NetworkProtection | null, now = Date.now()) {
  return environment.kind === 'vm' && environment.state === 'running' && environment.network.strict
    && Boolean(protection?.active && protection.integrity === 'verified' && protection.leaseActive
      && freshReading(protection.checkedAt, now, Math.min(45_000, protection.leaseRemainingMs ?? 0)));
}
export function windowsGuardSummaryVerified(environment: Environment | undefined, protection: NetworkProtection | null, connected: boolean, now = Date.now()) {
  return Boolean(connected && environment && protectionVerified(environment, protection, now) && freshReading(protection?.checkedAt, now, 15_000));
}
export function exitVerified(environment: Environment, egress: EgressStatus | null, now = Date.now()) {
  const expected = environment.network.egressLock?.expectedIp;
  const receipts = egress?.verification?.receipts ?? [];
  return environment.state === 'running' && Boolean(expected) && egress?.status === 'verified'
    && egress.expectedIp === expected && egress.actualIp === expected && freshReading(egress.checkedAt, now)
    && receipts.length >= 2 && receipts.every(row => row.ip === expected)
    && new Set(receipts.map(row => row.receiver)).size >= 2;
}
export function jobRecovery(job: Job): { destination: StatusDestination; label: string; detail: string } | null {
  if (job.status !== 'failed' && job.status !== 'cancelled') return null;
  if (['delete', 'environment-rebuild'].includes(job.action)) return { destination: 'logs', label: '检查清理记录', detail: '清理可能只完成了一部分，请先核对记录和剩余资料。' };
  if (job.action.startsWith('browser-') || job.action === 'open-browser') return { destination: 'browser', label: '检查浏览器', detail: '检查浏览器版本与恢复提示，再决定重试。' };
  if (job.action.startsWith('desktop-')) return { destination: 'desktop', label: '检查客户端', detail: '刷新客户端状态，查看安装或启动结果。' };
  if (job.action === 'install-agent') return { destination: 'agent', label: '检查 Claude Code', detail: '先读取已安装版本，再决定是否重新安装。' };
  if (job.action === 'install-desktop') return { destination: 'desktop', label: '检查桌面组件', detail: '刷新组件状态，核对未完成的准备记录后再继续。' };
  if (job.action === 'disk-grow') return { destination: 'settings', label: '检查扩容状态', detail: '设置页会显示未完成的扩容及恢复入口。' };
  if (job.action === 'disk-compaction') return { destination: 'settings', label: '检查磁盘回收', detail: '请在环境设置中打开“回收磁盘空间”，检查上次维护状态并保留原磁盘。' };
  if (job.status === 'failed' && ['start', 'restart'].includes(job.action)) {
    const resource = job.message === WINDOWS_OLD_RESOURCE_DISK ? 'RESOURCE_DISK' : Object.entries(WINDOWS_RESOURCE_ERRORS).find(([, message]) => message === job.message)?.[0];
    if (resource === 'DISK_GROWTH_PENDING') return { destination: 'settings', label: '检查扩容状态', detail: '先在环境设置中完成未结束的磁盘扩容。' };
    if (resource === 'DISK_COMPACTION_PENDING') return { destination: 'settings', label: '检查磁盘回收', detail: '磁盘维护结果尚未确认，请在环境设置中检查回收状态并保留原磁盘。' };
    if (resource === 'RESOURCE_DISK') return { destination: 'system', label: '查看宿主资源', detail: '请到系统设置的宿主资源保护查看虚拟磁盘所在卷的可用空间和预留。' };
    if (resource === 'RESOURCE_QUOTA') return { destination: 'system', label: '查看宿主资源', detail: '请到系统设置的宿主资源保护查看已登记容量和当前用户的虚拟磁盘配额。' };
    if (resource === 'RESOURCE_MEMORY') return { destination: 'system', label: '查看宿主资源', detail: '请到系统设置的宿主资源保护查看可用内存和启动预留。' };
    if (resource === 'RESOURCE_BUSY') return { destination: 'logs', label: '查看故障记录', detail: '等待另一台虚拟机的启动操作结束后再检查状态。' };
    if (resource === 'RESOURCE_FENCED') return { destination: 'system', label: '查看宿主资源', detail: '请先处理系统设置中显示的资源压力，再重新打开软件。' };
  }
  if (['start', 'restart', 'prepare-network', 'quarantine'].includes(job.action)) return { destination: 'network', label: '检查线路与防护', detail: '按故障记录修复后重新核验，通过后才恢复联网。' };
  if (job.action.startsWith('backup-')) return { destination: 'settings', label: '检查加密备份', detail: '重新打开加密备份窗口，核对任务状态和清理提示后再决定是否重试。' };
  if (job.action.startsWith('snapshot-')) return { destination: 'snapshots', label: '检查快照记录', detail: '核对当前快照与操作日志，确认上一步结果。' };
  return { destination: 'logs', label: '查看失败记录', detail: '保留失败原因，确认当前状态后再重试。' };
}
export function jobDuration(job: Job, now = Date.now()) {
  const duration = Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.createdAt));
  if (!Number.isFinite(duration)) return '';
  const seconds = Math.floor(duration / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
