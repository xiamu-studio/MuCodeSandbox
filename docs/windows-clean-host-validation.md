# 全新 Windows 与嵌套 Linux 验收

2026-10-21，在独立的 Windows 11 IoT Enterprise LTSC 2024 x64 评估虚拟机中完成。外层 VM 使用 Secure Boot、虚拟 TPM 和嵌套虚拟化；其网卡未连接交换机。仅使用合成本地管理员与普通用户，应用用户不属于 Administrators。管理员代理由另一个本地管理员账号运行。

## 已验证结果

- 安装前 Hyper-V 为 Disabled，管理模块和服务不可用，仅系统准备会话拒绝 VM 操作。
- 生产固定操作真实启用缺失的 Hyper-V，返回 completed、changed=hyperv 和待重启要求；安装前后客体启动标记一致，没有自动重启。
- 操作者仅重启测试 VM。新的检测会话确认 Hyper-V、管理模块、vmms 和 OpenSSH 客户端就绪，才启用 VM 管理。
- 普通用户通过生产权限代理创建并启动内层 Linux，使用认证的 Hyper-V socket/SSH 管理连接，验证 dev 的 UID=2001 和关闭的业务联网许可。
- 确认内层 VM 停止后删除其专属交换机、磁盘和管理文件。独立检查内层 VM 数量为零；外层评估 VM 最后也确认 Off。
- 安装阶段 3 项、重启后与 Linux 阶段 5 项检查通过。物理宿主启动时间、Mac main 引用均与测试前一致；没有访问 AI 网站。

OpenSSH 客户端在微软镜像中已经安装，本轮验证其实际可用性。缺失 OpenSSH 时的真实 Add-WindowsCapability 安装仍须补测。此结果覆盖隔离评估 VM 中的后端流程，第二台 Windows 11 Pro、全新机器的图形 UAC/安装向导和真实 Mac 回归仍分别保留。

## 实测发现与修复

另一管理员账号不能复制普通用户进程的主令牌。代理现在只申请进程查询/同步和令牌查询权限，检查实际令牌是否提升，持有原进程句柄防止身份重用；输入文件在已验证 PID、SID 的管道调用者上下文中打开。没有增加用户组成员资格，也没有启用调试权限。

嵌套 Windows 能检测到外层 hypervisor，刚启用内层 Hyper-V 时管理服务仍可能需要重启。组件准备保留每步回执，并在 Windows 要求重启或管理模块尚不可用时等待重启，不提前启动服务。新回归测试覆盖这一路径。

首次实测的失败回执保留在本机。修复后先确认内层 VM 已清理，再仅在评估客体中禁用并重新启用 Hyper-V，完成上述 3+5 项重跑；没有修改物理宿主的 Hyper-V 配置。

同时通过 82 项 Windows 自动测试、独立部署磁盘保护检查、8 项权限负向检查及控制器强退后的独立停机检查。强退实验使用新的空白合成 VM，独立确认 Off 后才进入清理；没有用新代理的启动恢复替代强退证据。新未签名包的准备恢复/取消 4 项、组合安装/卸载 6 项检查也通过。

## 镜像与证据

镜像从 [Microsoft Evaluation Center](https://www.microsoft.com/en-us/evalcenter/download-windows-11-iot-enterprise-ltsc-eval) 的 x64 链接取得，版本为 26100.1742 刷新版，文件大小 5,060,020,224 字节，固定 SHA-256：

```text
2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29
```

微软所链接 PDF 中的不同摘要首先触发拒绝。新版固定摘要来源于独立原始下载记录：[Ventoy 实测报告](https://github.com/ventoy/Ventoy/issues/3194)、[windows-vagrant 镜像清单](https://github.com/rgl/windows-vagrant/blob/master/windows-evaluation-isos.json)。[Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2181328/issue-broken-windows-11-iot-hashes-pdf-link) 也记录了该差异。完整摘要重新校验后，另外核验 setup.exe、sources/setuphost.exe 的有效微软签名；原 PDF 校验失败记录和分段数据均保留。该摘要来源没有标记为微软发布的新校验清单。

Windows 映像只应用到新建的专用 VHDX；脚本核对磁盘路径、容量和非宿主启动/系统盘属性。客体 EFI 启动文件最终在 VM 内的 Windows PE 中生成，选择实际 EFI 分区号。宿主没有卸载或修改其活动 BCD。

本机忽略目录 `.mu-data/windows-run/clean-host-complete.json` 指向完整回执。磁盘、密码、应答文件、运行日志、截图和报告保留在本机，均不提交。`windows-clean-host*` 与相应 PowerShell 是专用诊断夹具，使用本机已验证的空白 Linux 基盘，独立于产品安装器和 Mac 发布流程。

已存在且完成本地账号初始化的夹具可执行：

```powershell
node scripts/windows-clean-host-probe.ts before-reboot
node scripts/windows-clean-host-probe.ts after-reboot
node scripts/windows-clean-host-probe.ts collect-stop
```

第一条要求实际缺失 Hyper-V；重跑前的角色重置仅用于该空白评估客体。不要把诊断角色重置用于已有用户环境。

夹具准备分为镜像下载与校验、`windows-clean-host.ts --stage-only` 暂存、`--resume <夹具目录>` 应用新 VHDX，以及 `windows-clean-host-probe.ts pe-boot` 在客体内准备启动。`oobe` 切换到受支持的本地用户配置，区域和键盘页面可通过该测试 VM 的控制台确认。其数据索引只保存在本机忽略目录；这套诊断流程没有作为产品的一键安装功能发布。
