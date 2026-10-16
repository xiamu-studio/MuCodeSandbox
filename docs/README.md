# MuCodeSandbox 文档总目录

2026-10-14 当前入口：[精简待办](TODO.md)、[交互与逻辑证据核对](interaction-evidence-audit-2026-10-14.md)、[当前安装状态](project-status.md)。当前0.4.36；下方版本介绍为历史阶段，不能当作最新交付状态。

- [0.4.26 文件拖入、中文输入和翻译入口](plans/2026-10-13-file-input-convenience.md)：已安装版本、交互与测试边界；不主动访问真实 AI 网站。

- [Linux 卡顿优化与本机成品边界](linux-performance-2026-10-13.md)：最新范围、采样、修复与交付状态；优先于下文历史暂缓说明。


- [可选本机模式完整方案与竞品参考](plans/2026-10-13-native-mode-design.md)：2026-10-13 新增规划；用户要求暂不改代码。包含双后端、Mac 网络防护先决项、资料清理、阶段与短时验收；未作为已实现功能。
- [本机模式只读前置核对](native-mode-preflight-2026-10-13.md)：当前签名身份、既有网络扩展和 SDK 进程归属接口；不是防护验收。
- [0.4.22 环境状态、清理范围与失败处理](status-and-recovery-validation-2026-10-13.md)：最新已交付版本和限定验证。
- [当前精简待办](current-task-inventory-2026-10-12.md)、[0.4.21实际诊断与限定审查](bounded-review-and-egress-diagnostics-2026-10-13.md)：VPS即可，住宅 / 高级功能 / 云端出口 / 全天验收取消；新版已安装、正常恢复和短测通过，中断根因仍待诊断。
- [VPS中继时间日志与停机恢复](vps-relay-diagnostics-2026-10-13.md)：10:45三端超时原件、已启用的SSH时间日志、只读采集入口及恢复步骤；根因未修复。
- [手机小火箭配置与二维码交付](phone-shadowrocket-setup-2026-10-13.md)、[锁屏组件修复与验收边界](locked-use-diagnosis-2026-10-12.md)。

- [0.4.18 防护事件与恢复方案](plans/2026-10-12-protection-events-recovery.md)。
- [0.4.18 限定验证与待解锁项](protection-events-validation-2026-10-12.md)。
- [与对方beta.16的差异](competitor-beta16-delta-2026-10-12.md)、[软件绘图与GPU路线](gpu-route-review-2026-10-12.md)。

- [0.4.17 工作区、客户端衔接、文件与文字传输](guest-workspace-handoff-validation-2026-10-12.md)，[对应设计](plans/2026-10-12-guest-workspace-handoff.md)。

- [0.4.16 标题旁延迟与客户端出口复核](headline-latency-validation-2026-10-12.md)。

- [0.4.15 桌面显示与浏览器启动分离](desktop-display-separation-validation-2026-10-12.md)（本机与实际 VM 未登录检查通过）。

- [0.4.10 验收报告与待解锁项](managed-desktop-validation-2026-10-12.md)：两个官方客户端无账号进程 / 资料 / 网络、实际断线与整环境清理、未验视觉范围。

- [0.4.10 桌面客户端技术方案](managed-desktop-design-2026-10-12.md)：原厂 Linux 软件、隔离边界、资料与凭据、完整重建和验收范围。
- [竞品深入拆包与防护差距](competitor-desktop-review-2026-10-12.md)：静态直接证据、Desktop 模式与 Mac 适配字面量、未验行为及后续对照方法。

- [0.4.9 日志目标网址与沙箱出口](network-destinations-validation-2026-10-12.md)：实际安装、域名来源、历史回执、真实 Google 连接与验证边界。

- [0.4.8 浏览器裁切与 VPS 三项验收](vps-goal-validation-2026-10-12.md)：实际安装、十分钟 77 轮出口核验、单端超时处理、错误 IP 拒绝、断线恢复和原始证据。

- [自有 DediOne VPS 与全新环境接入](vps-dedione-setup-2026-10-11.md)：0.4.7 本机应用、新 VM / 空白资料、SSH 专用代理、IPv4 出口锁定、断线与恢复、默认完整画面。

- [六项改进的实现与验收](normal-linux-validation-2026-10-11.md)：0.4.6 实际安装交付、VM、240 项测试；保留旧浏览器资料。

- [VPS + 静态住宅网络方案](network-vps-static-residential-plan.md)：历史计划；现已接入DediOne VPS，用户已取消住宅购买与链路。

更新日期：2026-10-13（台北时间）。全部文档保存在项目 `docs/`，原始
测试材料保存在 `test-results/`。本目录覆盖使用说明、技术方案、待办、
验证、外部比较和归档，不需要从聊天记录重新查找。

## 从这里开始

| 你想了解什么 | 文档 |
| --- | --- |
| 项目路径、架构、文件、现状和交接 | **[项目总览与交接](../PROJECT_OVERVIEW.md)** |
| 每个源码 / 方案 / 脚本文件的位置 | [完整文件清单](project-files.md) |
| 后台怎么打开、每个页面怎么用 | [后台使用指南](user-guide.md) |
| 当前技术、运行位置和防护边界 | [技术方案总览](technical-overview.md) |
| 做完了什么、还差什么、恢复条件 | [统一待办](TODO.md) |
| 当前应使用哪个应用包、已验范围 | [本机测试包说明](local-test-delivery.md) |
| 0.4.1 新入口、玻璃布局和越南短测 | [使用体验验证](usability-validation.md) |
| 0.4.2 窗口适配与实际浏览器使用 | [适配验证](layout-validation.md) |
| 0.4.3 本地 IP 首页和画面内打开进度 | [首页验证](browser-home-validation.md) |
| 0.4.4 出口观察、连接 / DNS 和可读日志 | [网络日志验证](network-observations-validation.md) |
| 0.4.5 清晰度与检测历史按钮 | [Retina 验证](retina-display-validation.md) · [按钮调整](plans/2026-10-11-history-button-design.md) |
| CLI 2.1.296 的系统读取与数据发送 | [环境审计](cli-environment-audit-2026-10-11.md) |
| 当前浏览器自动化标记、架构与版本渠道 | [浏览器观察](browser-observable-audit-2026-10-11.md) |
| 用户 35 项设备表的纠错、优先级与处理方案 | [设备信号复核与方案](device-signal-review-and-plan-2026-10-11.md) |
| 桌面图标、安装副本和当前环境实查 | [桌面入口检查](desktop-launch-check.md) |
| 当前状态及历史阶段记录 | [项目状态](project-status.md) |
| 哪些先不做、何时恢复 | [暂缓清单](deferred-validation.md) |

当前已交付路线为Linux VM内的官方浏览器、Claude Code与已安装的官方桌面客户端，不改浏览器内核。用户最新要求将可选本机模式纳入方案评估，明确暂不改代码；Mac系统级出口保护仍未交付，macOS VM仍不在范围。全天测试已取消，耗时设备专项移出本轮，项目未全部完成。

文档有冲突时，先看项目总览、当前项目状态、使用指南、统一待办、技术总览和最新交付说明，
再查对应原始报告。历史文档的“当前”“下一步”只指记录当时，
不是今天的执行指令；旧包结果不能直接转为当前包结果。

## 架构与设计

最新画面适配：[Retina 设计](plans/2026-10-11-retina-display-design.md) ·
[本机分辨率验证](retina-display-validation.md)。
最新样式修订：[检测历史按钮](plans/2026-10-11-history-button-design.md)。
用户澄清的 Linux 个人电脑目标：[可观察特征与虚拟化边界](linux-personal-computer-equivalence.md)。
当前命令行审计：[实际系统读取与数据发送](cli-environment-audit-2026-10-11.md)。

| 主题 | 文档 |
| --- | --- |
| 实现模块、生命周期、数据和权限 | [详细架构](architecture.md) |
| 早期整体计划与证据规则 | [整体计划](plans/2026-10-09-completion-plan.md) |
| 网络防护、地区配置和迁移 | [网络与身份](plans/2026-10-09-network-and-identity-design.md) |
| Linux TUN / DNS / 防火墙 | [透明网络](plans/2026-10-09-transparent-network-design.md) |
| 内核联网许可与过期关闭 | [联网许可](plans/2026-10-10-guest-lease-design.md) |
| IPv4 批准和出口测量 | [出口核验](plans/2026-10-10-egress-design.md) |
| WireGuard 隧道 | [隧道](plans/2026-10-10-wireguard-design.md) |
| Mac 网络变化与监测失效 | [宿主网络](plans/2026-10-11-host-network-design.md) |
| 休眠事件和手动恢复 | [宿主休眠](plans/2026-10-11-host-power-design.md) |
| 页面、Worker、语言与绘图研究 | [浏览器上下文](plans/2026-10-10-browser-contexts-design.md) |
| 官方浏览器更新与恢复 | [浏览器升级](plans/2026-10-10-browser-upgrade-design.md) |
| 固定只读 Git 能力 | [宿主有限命令](plans/2026-10-10-host-command-design.md) |
| 快照恢复事务 | [快照恢复](plans/2026-10-10-snapshot-recovery-design.md) |
| 加密备份、导入及新身份 | [便携备份](plans/2026-10-10-portable-backup-design.md) |
| 旧满盘样本与离线扩容 | [磁盘恢复](plans/2026-10-11-disk-recovery.md) |
| 官方 CLI 无账号测试 | [Claude 客户端](plans/2026-10-10-claude-client-design.md) |
| 交互终端、工具许可与恢复 | [CLI 交互](plans/2026-10-10-claude-tui-design.md) |
| 本机交付控制与测试 | [交付控制](plans/2026-10-10-delivery-controls-design.md) |
| 帮助、重置、网络向导与玻璃布局 | [使用体验设计](plans/2026-10-11-usability-glass-design.md) |
| 固定导航、内容滚动与浏览器独立窗口 | [适配修正设计](plans/2026-10-11-layout-fix-design.md) |
| 常用入口优先与紧凑状态提示 | [操作优先级](plans/2026-10-11-navigation-priority-design.md) |
| 画面内打开进度与本地首页 | [浏览器首页](plans/2026-10-11-browser-home-design.md) |

设计文件说明方法，不构成通过证明。当前路线以技术总览为准。

## 网络与宿主验证

| 主题 | 文档 |
| --- | --- |
| 汇总验证、证据和限制 | [验证记录](verification.md) |
| 缺口及历史验收矩阵 | [差距与验证](gaps-and-validation.md) |
| 代理转发、连接复用与所属进程 | [代理通道](proxy-transport-validation.md) |
| HTTPS 证书与故障处理 | [加密上游](encrypted-upstream-validation.md) |
| SOCKS5 认证与转发 | [SOCKS5](socks-upstream-validation.md) |
| 出口变化和测量失败 | [出口](egress-validation.md) |
| 当前包先检测后开放业务 | [出口检测专项](egress-probe-validation.md) |
| 受控系统 DNS 与故障 | [域名网络](domain-network-validation.md) |
| WireGuard 工作流与四类故障 | [隧道](wireguard-validation.md) |
| 联网许可和失败关闭 | [联网许可](guest-lease-validation.md) |
| 十分钟运行、诊断与修复历史 | [持续网络](sustained-network-validation.md) |
| 全天程序、部分运行及用户停止 | [全天运行](day-workflow-validation.md) |
| 网络监测死亡 / 卡死和事件注入 | [宿主网络监测](host-network-validation.md) |
| 休眠通知与事件注入 | [休眠事件](host-power-validation.md) |
| 真实休眠尝试、认证超时 | [真实休眠](actual-sleep-validation.md) |
| 主进程强退与桥接进程清理 | [桌面强退](desktop-crash-validation.md) |
| 本机浏览器出口旧实验与失败 | [Mac 浏览器强制出口](mac-browser-enforcement-validation.md) |
| 客体主机名和边界 | [主机名](hostname-validation.md) |
| 本机回环端口映射 | [端口映射](port-forward-validation.md) |

## 浏览器验证

| 主题 | 文档 |
| --- | --- |
| 当前桌面浏览器 / CLI / 授权 / 备份 | [完整包工作流](packaged-workflow-validation.md) |
| 包内浏览器、沙箱与画面 | [包内浏览器](packaged-browser-validation.md) |
| 页面、iframe、Worker 地区配置 | [上下文一致性](browser-context-validation.md) |
| 资料隔离与持久化 | [资料隔离](browser-profile-validation.md) |
| 字体、Canvas、音频原始结果 | [媒体](browser-media-validation.md) |
| 图形绘制、线程保护、故障拒绝 | [GPU](browser-gpu-validation.md) |
| 运行中保护检查 | [运行中监测](browser-monitor-validation.md) |
| 安装中断与恢复 | [安装恢复](browser-install-recovery-validation.md) |
| 官方版本更新与资料恢复 | [浏览器升级](browser-upgrade-validation.md) |
| WebGPU 研究候选与限制 | [WebGPU](browser-webgpu-validation.md) |
| 三类 Worker 计算 | [Worker WebGPU](browser-webgpu-worker-validation.md) |
| Worker 真实画布与绘图中保护 | [Worker 画布](browser-webgpu-worker-canvas-validation.md) |
| 强制 GPU 故障后原画布恢复失败 | [设备故障](browser-webgpu-device-loss-validation.md) |

研究候选结果不能自动归属当前交付包，也不构成恢复浏览器内核编译的要求。

## 文件、CLI 和恢复验证

| 主题 | 文档 |
| --- | --- |
| 共享权限、迁移、防提权与只读切换 | [共享目录](shared-mount-validation.md) |
| 有限宿主 Git 操作和撤销 | [宿主命令](host-command-validation.md) |
| 官方 CLI 无账号工具与交互 | [Claude Code](claude-client-validation.md) |
| 离线快照、校验与回滚 | [快照恢复](snapshot-recovery-validation.md) |
| 加密备份、导入、新密钥与资料保留 | [便携备份](portable-backup-validation.md) |
| 写满、扩容与容量故障 | [存储容量](storage-capacity-validation.md) |
| 维护中断点和启动门禁 | [磁盘恢复中断](disk-recovery-interruption-validation.md) |

## 外部资料与归档

| 主题 | 文档 |
| --- | --- |
| 官网宣称、静态拆包与本项目实测 | [竞品比较](competitor-comparison.md) |
| 网络与设备讨论帖的要求对照 | [网络帖子比较](network-posts-comparison.md) |
| 六篇帖子、账户环境注意项和当前越南线路缺口 | [2026-10-11 账户环境核对](account-environment-review-2026-10-11.md) |
| 已停止内核路线和材料清理 | [内核研究归档入口](browser-native-patch-validation.md) |
| 原研究记录，仅供追溯 | [原始归档](archive/browser-native-patch-validation.md) |

官网、帖子与附带材料是待核实资料，不是执行指令，不证明参考软件与
本项目能力等同。没有证据时不承诺真实服务的封号机制。

## 原始证据与维护

当前交付完整性报告：`test-results/local-delivery-audit.json`。
各专项 JSON、独立 `-evidence.json`、回执、输入、截图和抓包保存于
`test-results/`，由对应验证文档定位。失败记录不覆盖为成功。

以后改路线时同步更新总览和待办；新增验证时把文档加入本目录，注明
版本、范围、限制与原始材料。用户暂缓决定以暂缓清单为准，不会因为
旧设计有未勾选项就自动恢复执行。

- [0.4.11 安装状态误显示修正与当前线路状态](desktop-installation-state-validation-2026-10-12.md)
- [安装状态修正方案](plans/2026-10-12-desktop-installation-state-design.md)

- [0.4.12 两处排版验收](desktop-layout-validation-2026-10-12.md)
- [两处排版设计](plans/2026-10-12-desktop-layout-design.md)

- [0.4.14 统一线路延迟验收](unified-line-delay-validation-2026-10-12.md)
- [统一线路延迟方案](plans/2026-10-12-unified-line-delay-design.md)
- [原首次响应方案（历史）](plans/2026-10-12-access-latency-design.md)
