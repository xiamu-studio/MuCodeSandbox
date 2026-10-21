# Windows 缺失 OpenSSH 客户端验收

2026-10-21，在已有的隔离 Windows 11 IoT Enterprise LTSC 2024 评估虚拟机中完成。外层网卡一直未连接交换机；应用以合成普通用户运行，生产权限代理使用另一个合成本地管理员。没有访问 AI 网站或使用真实账号。

## 实测结果

- 仅在空白评估客体中真实执行 `Remove-WindowsCapability`。确认能力为 `NotPresent`，`ssh.exe` 和 `ssh-keygen.exe` 均不存在；移除前后启动标记相同。
- 缺失客户端时，新检测会话没有 VM 运行权限，实际启动请求被拒绝。
- 没有本地安装源且断网时，生产准备操作失败，错误码为 `0x8024402C`。受保护 Windows 作业回执与客户端结果匹配；`ready` 和 `runtimeActive` 仍为 false，没有将失败当作安装成功。
- 给评估客体配置微软官方 FoD 离线源后，原生产固定操作实际安装了缺失客户端，受保护回执为 completed、changed=ssh-client，文件和能力状态均就绪。没有重启，原会话仍无 VM 权限。
- 新的普通用户检测会话确认就绪后，实际创建、启动并配置嵌套 Linux，验证 dev UID=2001、业务许可关闭，随后确认停止并删除内层 VM、专属交换机与磁盘。
- 安装阶段 3 项、重新检测和 Linux 阶段 5 项检查通过。独立管理员收集安装成功和断网失败回执、确认内层 VM 为零，移除夹具专用源策略，最后确认评估 VM 为 Off。

物理宿主启动标记、Mac main 引用均未改变。Windows 自动测试 84 项及部署磁盘保护检查通过；更新后的未签名 NSIS 包完成安装、忙碌拒绝覆盖/卸载、重复安装和卸载保留数据共 5 项检查。

## 发现与修复

原脚本错误地向 `Add-WindowsCapability` 传入 `-NoRestart`。该参数属于 `Enable-WindowsOptionalFeature`，不在实际 DISM 能力安装命令中。之前的镜像预装客户端，使此路径未执行；原模拟命令也错误接受该参数。现在移除无效参数，并用本机实际 DISM 命令元数据检查生产命令的参数。

此外，组件命令返回后重新检查实际就绪状态；既未就绪又无待重启要求时，作业必须失败。回归测试覆盖能力命令无异常但组件仍缺失的情形，避免产生错误的 completed 回执。参考 [微软命令文档](https://learn.microsoft.com/en-us/powershell/module/dism/add-windowscapability) 和 [微软离线安装说明](https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/cant-install-openssh-features)。

## 离线源与复现边界

FoD 来自 [微软 Windows 11 语言与可选功能文档](https://learn.microsoft.com/en-us/azure/virtual-desktop/windows-11-language-packs) 链接的 24H2/25H2 官方 HTTPS 介质。诊断脚本使用固定来源、HTTP Range、响应范围与 ETag 检查，只读取索引及所需 CAB 的约 18 MiB；没有下载或声称校验完整 6.25 GB ISO。

提取的固定文件为 `OpenSSH-Client-Package~31bf3856ad364e35~amd64~~.cab`，2,014,456 字节，SHA-256：

```text
6d2259ebe546ff24c7a54fd40b8e14988b66dcc76968324c9839568d617e9256
```

提取的 5 个目录签名均核验为 Valid、Microsoft Windows；实际安装仍经过 Windows 自身的组件目录验证，没有关闭签名或放宽信任。夹具只配置客体的固定 `LocalSourcePath`，验收后移除。生产权限接口没有增加调用者指定包、脚本或源路径的能力，正常产品继续使用 Windows Update 或管理员预先配置的组件源。

`scripts/windows-clean-host-fod.py` 是独立诊断工具，需要 pycdlib 1.16.0；它不随安装包发布。已初始化的专用评估夹具依次使用 `windows-clean-host-probe.ts` 的 `ssh-inspect`、`ssh-remove`、`ssh-source`、`ssh-install`、`ssh-ready`、`ssh-collect` 阶段。移除只允许空白夹具，旧证据不会作为新安装成功的替代。

本机忽略文件 `.mu-data/windows-run/clean-host-ssh-complete.json` 指向完整私有回执。源策略辅助、账号、磁盘、密钥、日志、CAB 与截图不提交。此结果仍不覆盖第二台 Windows 11 Pro、全新机器的图形 UAC/向导、跨版本升级或 Mac 实机回归。
