# 隔离 Windows 客体的网络变化验收

2026-10-21，在 Windows 11 IoT Enterprise LTSC 2024 评估 VM 中，以普通用户、另一管理员和真实嵌套 Linux 完成 13 项检查。外层 Windows VM 的唯一网卡一直未连接宿主交换机；没有访问 AI 网站、外部接收端或真实账号。

## 三组实际变化

| 场景 | 在评估 Windows 内执行的实际操作 | 验证结果 |
| --- | --- | --- |
| 网卡状态 | 禁用该评估客体自身的断网网卡 | 生产监测器检测变化，确认 Linux Off |
| DNS | 给同一网卡设置保留测试 DNS 地址 | 同上，无回退或继续使用原会话 |
| 路由 | 给同一网卡添加保留测试网段路由 | 同上，无回退或继续使用原会话 |

每组使用独立新建的 Linux VM、生产 `createWindowsService`、`WindowsManager` 和 `WindowsHostMonitor`。只为客体添加本地合成 CA，出口使用回环 HTTPS/DoH/CONNECT 夹具；夹具只接受固定保留测试目标，其他目标一律拒绝，不建立互联网连接。

每组四项检查，加上普通用户生产代理绑定检查，共 13 项：

1. 改变网络前，真实 Linux VM 为 Running，业务许可有效，两个本地 TLS 接收端验证出口，持续 TLS 流已建立。
2. 管理员只改变绑定的评估客体网卡。生产指纹发生变化，生产监测器将宿主网络标记为 failed，实际 Hyper-V 状态确认为 Off。
3. 已建立 TLS 流停止，新的业务请求失败；原应用再次启动环境收到 `HOST_NETWORK_CHANGED`，不会自动恢复旧会话。
4. 停机后删除本组 Linux VM、专属 Private 交换机和磁盘。

独立管理员收集结果时核对三种不同场景及与当前 PID/nonce 会话匹配的受保护变化回执，确认嵌套 VM 为零；恢复测试 Windows 网卡原有 DHCP/DNS，移除测试地址与路由，最后确认评估 VM 为 Off。物理宿主启动标记、Mac main 引用均未改变。

## 范围与复现

这证明真实 Windows 网络配置变化会触发生产防护关闭，以及关闭后的旧连接、新连接和重新启动行为。它没有覆盖物理 Wi-Fi/网线切换、实际操作系统休眠/唤醒，或对这些过程进行逐包外部观测；这些项目继续保留，不用状态机单测或本次客体测试替代。

`scripts/windows-clean-host-network-inputs.ts` 准备本地合成 TLS 材料和编译后的接收端。已初始化、空白且断网的专用 Windows 夹具依次运行 `windows-clean-host-probe.ts` 的 `network-prepare`、`network`、`network-collect` 阶段；`network-inspect` 只读检查进度。网卡按外层 VM 的实际 MAC 和客体 InterfaceGuid 绑定，不能由调用者传任意网卡。所有变化命令均在 PowerShell Direct 会话内执行。

本机忽略文件 `.mu-data/windows-run/clean-host-network-complete.json` 指向完整私有回执，包括三组配置、源码摘要及资源清理结果。运行数据、指纹、合成密钥和账号不提交；这些诊断工具不随产品安装包发布。
