// Stable public messages also identify existing persisted Windows job failures.
export const WINDOWS_RESOURCE_ERRORS:Record<string,string>={DISK_GROWTH_PENDING:'请先在磁盘扩容中继续未完成的操作，完成前业务启动保持关闭',DISK_COMPACTION_PENDING:'磁盘维护未确认，原磁盘已保留，请先检查操作记录',RESOURCE_DISK:'磁盘空间不足以满足增长缓冲及本次操作，原磁盘已保留',RESOURCE_MEMORY:'可用内存不足以启动环境并保留宿主所需内存',RESOURCE_QUOTA:'已达到当前用户的虚拟磁盘容量预留上限',RESOURCE_BUSY:'另一个虚拟机正在启动，请稍后重试',RESOURCE_FENCED:'资源保护已关闭本次运行会话，请处理资源压力后重新打开软件'};
export const WINDOWS_OLD_RESOURCE_DISK='磁盘空间不足以容纳已有动态盘增长及本次操作，原磁盘已保留';
