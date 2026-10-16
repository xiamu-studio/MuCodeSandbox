# 本机模式前置条件：只读核对

2026-10-13 最新决定：用户恢复 Linux 优化和本机模式，验收要求为最终可日常使用；不以离线演示替代交付。本机签名 / 系统防护条件尚未具备，原型试验未通过，停止扩大演示；优先交付 Linux 卡顿修复。以下“暂缓 / 暂不改代码”按历史时点理解，最新证据见[本轮进展](linux-performance-2026-10-13.md)。

核对日期：2026-10-13；过程中时钟回执为 17:05:52 台北时间（09:05:52 UTC）。范围：本机系统元信息、应用签名、已激活网络扩展、进程可执行路径与 SDK 声明；没有读取网页内容、浏览器资料、私钥或代理密码，没有启动测试浏览器、安装组件或修改应用代码。

历史检查发生在“先给完整方案，暂不改代码”阶段。此后用户已恢复实施，并要求最终可用；当前状态以文末复核为准，不能将历史说明当作现行授权限制。

## 实际发现

| 检查 | 当前证据 | 对方案的影响 |
| --- | --- | --- |
| 系统 | `sw_vers`：macOS 26.3.1 / 25D2128 | 当前系统版本满足所查网络过滤 API 的最低版本；不证明特定实现可用 |
| 签名资源 | `security find-identity -v -p codesigning`：`0 valid identities found` | 当前查询未发现可用身份；不能因此断言用户没有开发者账号。正式系统扩展的签名资源需另行准备或确认 |
| 当前 MuCodeSandbox | `local.mucodesandbox.app`；adhoc；TeamIdentifier 未设置 | 现有包不具备已经落实的 Developer ID 系统扩展交付链 |
| 本机 Chrome | `com.google.Chrome`；Google LLC / EQHXZ8M8AV；有附带公证票据的签名元信息 | 可作为正式 Mac 浏览器候选。这次是签名元信息读取，不替代完整包验证或网络防护测试 |
| 已激活网络扩展 | `com.nebula.karing.karingServiceSE` 1.2.21/2402；`cn.threatbook.Cardinal.net-extension` 2.7.0.1000.808/1，均 activated enabled | P0 要包含共存检查；不禁用现有扩展，不借用第三方签名或把它们视为本项目保护 |
| 构建接口 | `xcrun --sdk macosx --show-sdk-path` 返回 CommandLineTools 下的 SDK | 可继续核对接口；未据此判定完整 Xcode、描述文件或签名打包环境已经齐备 |
| 活跃进程 | 日常 Chrome 主进程和多个 helper 在运行；MuCodeSandbox 也有自己的 helper 和 network monitor | 单看名字不足以区分资料与流量；新方案必须验证来源应用、实际 helper、启动代次和规则归属，不能误关个人 Chrome |

进程检查仅使用 PID、PPID、可执行文件路径，未读取完整命令参数，未收集标签页或账号信息。PID 是当时的快照，不用作后续稳定身份。

## SDK 核对：需要修正的实现假设

读取本机 SDK：

`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/NetworkExtension.framework/Headers/NEFilterFlow.h`

- `sourceAppIdentifier`、`sourceAppUniqueIdentifier` 和 `sourceAppVersion` 在该头文件中标为 macOS 不可用；不能直接搬用 iOS 的应用标识过滤写法。
- `sourceAppAuditToken` 在 macOS 10.15 起可用，用于来源应用。
- `sourceProcessAuditToken` 在 macOS 13 起可用，用于实际创建连接的进程；系统进程代应用建连时，两者可能不同。
- 字段都可能为空。分类失败必须有明确处理，不能默认批准受管应用连接。

因此 P0 应检查“受管 Chrome 与个人 Chrome 的 token / helper 归属”，并覆盖系统代办连接、新生 helper 和进程重启。API 的存在不证明同一 Chrome 的多 profile 自动拥有不同应用身份。

来源：[Apple sourceAppAuditToken](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceappaudittoken)、[Apple sourceProcessAuditToken](https://developer.apple.com/documentation/networkextension/nefilterflow/sourceprocessaudittoken)，本次具体可用性与说明以已读取的本机 SDK 声明为依据。

## 当前不能标完成的事项

1. 系统扩展构建、签名、正常系统授权和实际启用。
2. 新过滤器与既有 Karing / 安全软件的共存。
3. 浏览器 / helper / 系统代办连接准确归属。
4. 保护失联、许可到期和中继中断后的旧连接关闭与无直连回退。
5. Mac 图形实际硬件加速和新本机模式的资料清理。

这次检查使 P0 的前置条件更明确，但未证明本机严格模式可交付。既有 `sandbox-exec` 失败未出现新的修复依据，本轮没有重跑同一失败实验；也没有用单纯代理模式代替用户要求的防护。

用户已允许实施；后续曾尝试空白资料原型但未通过，也未交付。真实系统扩展部署条件到位后，才继续有实际验收路径的实现，不再要求重复授权或扩大演示。


## Linux 体验验收后的部署条件复核

2026-10-13：用户确认 Linux 网页使用已明显顺畅。重新执行 `security find-identity -v -p codesigning` 仍返回 `0 valid identities found`；`native/` 文件清单仍无 NetworkGuard 系统扩展实现，只有已有监测工具、探针及离线原型。故本机模式未完成，不能仅称为“等待安装”。

重新读取 [Apple TN3134](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment) 官方 Markdown：macOS content filter provider 使用 system extension；该部署支持 App Store 或 Developer ID 直接分发。当前项目为自制并直接安装的应用，未找到可用的 Developer ID 身份。Apple 文档的部署能力不能替代本项目签名、配置、实现与实测。

这个限制只针对所选系统扩展交付路线，不是“没有开发者账号就不能运行任何 Mac 软件”。普通独立浏览器可以运行，但尚不能满足本项目受管进程防绕过、许可失效关闭和故障隔离的既定要求。既有失败的 SBPL 路线没有新的修复证据；全 Mac 接管会扩大范围，未拿它替代按环境保护。用户已经明确暂无开发者账号，不重复索要，也不改变系统安全设置来加载未获授权的扩展。
