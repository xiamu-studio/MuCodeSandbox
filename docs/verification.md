# MuCodeSandbox 0.4.0 候选验证记录

日期：2026-10-11。实机：Apple Silicon Mac、macOS 26.3.1、Node.js 24.15.0、Electron 44.7.0、Lima 2.2.0；客体 Ubuntu 24.04 ARM64。

本轮优先 Linux VM 浏览器与 Claude Code。验证不登录 Claude、不调用付费模型，不使用真实账户尝试是否封号。报告保存到本机 `test-results/`，未提交到源码库。

23:59:28 UTC 新长期验收程序的实际 9621b0a 短测独立复核通过：
124,221 ms 稳定阶段、五次浏览器 / CLI / 防护观察、持续流不重连，
两份物理抓包 754 / 888 包均为批准 SSH，未批准 0，资源清理。
报告 SHA-256 `03504e602c8c2e46e4d6d658bafdd5660c03e9419b06c36fe3195197b91879bc`。
完整 24 小时任务已于 10 月 11 日 00:01:47.793 UTC 开始稳定计时，
第一轮通过，尚未满时长或独立验收。[专项](day-workflow-validation.md)。

00:08:06 UTC 当前包维护开机 / 实际桌面 pending SIGKILL 独立复核
通过，防护先于 networkd，业务许可关闭 / 实际 UI 重试 / 文件保留
和无 UI 迟到启动约 8.15 秒自动关闭通过。六份抓包未批准外发 0，
临时资源清理。报告 SHA-256
`518931ef6871995dc44abd1f08018315db5819f1dac3f8668be1ddb548191a20`。
不是所有首包或整机断电。[范围](disk-recovery-interruption-validation.md)。

00:15:00 UTC 当前包系统加密 DNS 专项独立复核通过，188,231 ms
新域名稳定阶段、22 个域名 / 215 条 DNS 回执 / 22 条网站回执，
三类故障拒绝和恢复，六份抓包未批准外发 0，资源清理。报告
SHA-256 `7ec1da6435297d203734bb9e2a11cf9ee2f073015bea96ae38f00b5615abb79b`。
不是公共 / 住宅线路、浏览器 DNS 或全天。[范围](domain-network-validation.md)。

00:23:27 UTC 当前包实际双 VM WireGuard 浏览器 / 原生终端 CLI /
授权与取消恢复 / 对端断线 / 重启资料保留独立复核通过，四份物理
抓包未批准外发 0，资源清理，45 个后台模块和桌面主程序核验。
报告 SHA-256 `83d1b8305e9b177f2aa4e23dbbe0885592ad695824df92470c2dc6d2970e6ab8`。
不是全部故障、住宅对端或全天。[范围](wireguard-validation.md)。

00:28:05 UTC 当前包共享目录实际界面首次 / 重启 / 有效提权对照 /
改只读和旧写入拒绝 / 文件保留独立复核通过；三次不同开机、六份
物理抓包未批准外发 0，资源清理。报告 SHA-256
`669a88030c4bd0641a7ec06520bf384ad1a145b8837db68318bb8c979ce12a8e`。
不是全部映射、root 入侵或全天。[范围](shared-mount-validation.md)。

当前试用包为 `release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app`
（9621b0a），153 项源码测试 / 构建 / 包完整性通过。实际 Electron
主进程强退与手动恢复、完整浏览器 / 无账号 CLI / 宿主授权 / 快照 /
加密导入已独立复核，九份物理抓包未批准外发 0。HTTPS 与出口锁定
组合于 23:14:29 UTC 另独立复核，十份物理抓包未批准外发 0；当前
包身份和 45 个后台模块均核对。SOCKS5 与出口锁定组合于 23:19:43 UTC
另独立复核，八份客户端物理抓包未批准外发 0；两项临时资源清理。
旧包其他专项保留原范围。
[当前交付](local-test-delivery.md) · [出口组合](egress-probe-validation.md)。

当前包旧共享迁移专项于 23:24:52 UTC 独立复核：实际维护进程 SIGKILL、
拒绝访问 / 重试、旧快照恢复后重新迁移、文件保留和有效权限对照通过。
这是 Node 调用包内模块，没有实际 UI 或网络抓包。23:28:35 UTC 官方
浏览器 153 → 156 的实际 Electron 更新 / 恢复 / 重启另独立复核：五次
浏览器观察、三个资料故障拒绝、三份物理抓包未批准外发 0，退出
430 ms，45 个后台模块和桌面主程序核对。两项资源清理；旧版预安装
使用源码安装器。不是全部旧环境、全天或整机断电验收。
[共享迁移](shared-mount-validation.md) · [浏览器升级](browser-upgrade-validation.md)。

23:35:25 UTC 当前包 UI 恢复旧满盘 VM 独立复核通过；三份抓包中
首份为旧包开机，其余为当前包恢复后开机 / 任务，未批准外发 0。
23:44:26 UTC 当前包三点维护进程 SIGKILL / 实际界面重试及较小旧
快照恢复另独立复核，七个正常 boot ID / 十三份抓包未批准外发 0。
两项资源清理；旧满盘准备时先强制停止旧 VM。不是维护首包、实际
断电或全天验收。[容量](storage-capacity-validation.md) ·
[中断](disk-recovery-interruption-validation.md)。

以下为旧包当时的记录。

旧 b3b92b6 包已通过 146 项源码测试、类型 / 构建和包完整性。
20:23 UTC 桌面强退、无 UI 的迟到启动约 8 秒自动关闭、维护网络
服务启动前防护与 UI 重试六份抓包复核通过。20:30 UTC 完整浏览器 /
CLI / 宿主授权 / 快照 / 加密导入，四次正常开机与六份抓包复核通过。
两项未批准外发均为 0，资源清理。只有 manager.js 改变，其他 6031
应用资源与 e1caee5 相同。20:41 / 20:43 / 20:50 UTC 同包共享目录、
双 VM 隧道和三点维护中断 / 较小旧快照另独立复核通过，分别六 / 四 /
十三份抓包未批准外发 0，临时资源清理。20:52 UTC 持续网络故障恢复
与四份抓包复核通过，但断线前有四次短请求错误。单独复测又出现一次
连接超时，稳定性未通过；失败证据于 21:00 UTC 独立复核，两份抓包
未批准外发 0、资源清理。根因未定，不能写成零错误或全天稳定性
通过。旧满盘 / 迁移 / 升级仍按原包。
[交付说明](local-test-delivery.md) · [中断范围](disk-recovery-interruption-validation.md)。

此前冻结 e1caee5 包已通过旧满盘环境 UI 扩容恢复（19:29 UTC），
以及 UI 扩容后的完整浏览器 / CLI / 文件与固定 Git / 快照 / 加密导入
（19:43 UTC，六份抓包）和共享目录首次 / 重启 / 读写改只读（19:40 UTC，
六份抓包）。两项独立抓包复核于 19:48 UTC 再次采用分离 stdout 的
协议过滤读取通过，避免 tcpdump 诊断文字与数据包行交错。原报告摘要
不变，复核结果同时记录读取器摘要。WireGuard 的文本混流误判失败轮
保留，同一未改动包的重跑于 19:53 UTC 完成独立复核，四份原始抓包
未批准外发 0；浏览器 / CLI、对端断线恢复与重启通过。
20:12 UTC 扩容三点维护进程硬退出 / 实际 UI 重试 / 较小旧快照恢复
十三份抓包独立复核通过。20:13 UTC 桌面主进程强退、维护抓包和规则
加载先于 networkd、关闭业务联网与正常恢复六份抓包独立复核通过。
两项未批准外发均为 0；首次立即停机断言失败轮保留，迟到开机关闭
和无 UI 轮询的监测仍需补验。[详细范围](disk-recovery-interruption-validation.md)。
145 项源码测试、类型与包完整性通过；原核心 VM 保留。
实际 Mac 切网 / 休眠、全天、真实线路、整机断电及第二设备仍需验证。
详见 [完整流程](packaged-workflow-validation.md)、[共享目录](shared-mount-validation.md)
和 [容量记录](storage-capacity-validation.md)。

此前容量修复包 45e0b4a，于 18:31:11 UTC 完成实际 Electron / 新 VM
dev 满盘、原生终端、代理 / 旁路、重启、UI 满盘快照恢复及释放后写入，
18:31:43 UTC 独立复核六份抓包未批准外发 0、43 个模块和截图通过。
有界 APFS 的空间故障与立即回滚另通过；138 项源码测试和包完整性
通过。旧 cf031a2 的 cloud-init ENOSPC、仅 root 预留时降权抓包截断
及测试假设错误均保留；修复包完整浏览器 / CLI / 备份流程于 18:42 UTC
实测并独立复核通过：三次不同开机、五份抓包未批准外发 0、四阶段
浏览器资料、实际 CLI 交互与关闭清理、UI 授权 / 快照 / 加密导入。
临时资源删除。报告 `packaged-workflow-storage.json`，SHA-256
`fdf92a8c448952252109d7bb52bf1caabd31caf134ea042241b787b552838860`。
见 [容量记录](storage-capacity-validation.md)。

此前交付 `host-network-candidate`（cf031a2，约 360 MiB）：完整透明流程
于 17:49 UTC 通过；共享目录 UI 于 17:53 UTC 通过；双 VM WireGuard
浏览器 / CLI、对端断线恢复与重启于 17:57 UTC 通过。三项分别独立
复核五 / 六 / 四份抓包，未批准外发均为 0；网络监测在各流程检查点
正常，临时 VM / 数据删除。报告前缀 `packaged-workflow-network`、
`shared-mounts-ui-network`、`claude-tui-wireguard-network`。源码测试
138 项；实际 Mac 休眠 / 切网、全天、容量 / 升级故障等另验。

此前 `host-power-fix-candidate`（4227377，约 360 MiB）于 17:04 UTC
完成真实 Electron / 全新 VM 完整透明串联，17:05 UTC 独立复核通过：
UI 创建、浏览器四阶段资料、无账号官方 CLI TUI、原生终端清理、宿主
授权、快照 / 加密导入，三次不同开机与五份抓包未批准外发 0；临时
资源删除。另通过真实 VM 通知注入停机 / 手动恢复、先授权再首次打开
浏览器的目录修复、配置软链接拒绝、五份抓包与 41 个包内模块复核。
真实 Mac 休眠首包仍未验。源码测试 130 项、构建、签名 / 篡改拒绝、
实际 DNS / 磁盘配置及重开 / 布局通过。证据前缀 `packaged-workflow-power`、
`host-power-vm`、`delivery-controls-power`，详细范围见
[交付说明](local-test-delivery.md) 和 [通知记录](host-power-validation.md)。
旧包专项按原签名保留，不自动转移到该包。

此前 `local-test-candidate`（2651186，约 360 MiB）新增磁盘和完整 DNS
控件，实际 Electron 保存 / 输入拒绝 / 退出重开 / 布局及签名完整性通过。
另于 2026-10-10 15:55:05–16:02:31 UTC 完成全新 VM 透明串联，
16:02:54 UTC 独立复核通过：UI 创建 10 GiB / 2 GiB 沙箱、浏览器四
阶段持久化、无账号实际 CLI、宿主授权、UI 快照 / 加密导入、三次不同
开机记录、五份抓包未批准外发 0，临时环境删除。报告前缀
`packaged-workflow-delivery`；不扩展为新包共享 / 隧道 / 全天等专项。
详细范围见 [交付说明](local-test-delivery.md) 和 [完整串联](packaged-workflow-validation.md)。

此前 `boot-capture-candidate`（b0cd06d，约 360 MiB）于 14:13:54 UTC
通过实际 Electron / 空白 VM 透明模式完整流程，14:14:09 UTC 独立复核
通过：官方浏览器四阶段资料持久化、实际 CLI 授权 / 拒绝 / 中断 / 恢复 /
关闭清理、文件与 Git 状态授权、UI 快照和加密导入。五份物理抓包未批准
外发均为 0，三次启动记录匹配不同实时内核 boot ID，网络服务重启不覆盖
记录；十五个包内模块、脚本、原始文件及实际 PNG 复核通过，临时资源清理。
完整 123 项自动测试、十项包内原生边界测试、构建和签名 / 篡改拒绝通过。
修复了导入备份沿用旧启动 pcap 的证据问题及退出组信号错误造成关闭等待
不结束的问题。14:16 UTC 另通过新包实际 UI / 全新 VM 命令专项及独立复核：
活动命令下退出 143 毫秒无遗留进程，三份抓包未批准外发 0。该包尚不继承
旧包隧道、共享挂载或双版本专项。
详见 [完整串联](packaged-workflow-validation.md)。

14:26:38 至 14:31:00 UTC 同一 b0cd06d 包完成全新双 VM WireGuard
冷安装浏览器 / CLI、实际 TUI、真实页面 fetch 断线失败 / 恢复与重启
持久化；14:31:32 UTC 包身份、后台模块、源码 / 文件摘要、三个实际
浏览器 PNG、回执、两次不同 boot ID 与四份 pcap 独立复核通过。物理
输出 202 / 53,478 / 235 / 350 包，未批准均 0；安装后禁止客户端公网
双向转发，无真实账号 / 付费调用，所有临时 VM / 数据清理。不是长期、
所有故障、住宅线路或其他平台证明，见 [隧道专项](wireguard-validation.md)。

历史有限宿主命令包 `host-commands-listing-candidate`（74fda9a，约 360 MiB）于
13:33 UTC 通过实际 Electron / 全新 VM 的独立专项复核：八项包内文件与命令
边界测试、重复列目录修复、界面授权 / 撤销、停机撤销及阻塞命令下退出 203
毫秒。三份物理抓包 147 / 289 / 78 包，未批准外发均为 0；关闭阶段 1 个已配置
代理端口 9 的连接尝试不是业务代理联网成功。原包完整签名 / 篡改拒绝通过；
原生签名差异用临时副本相同重新签名后的完整文件比较核实。当时 121 项自动
测试与构建通过，临时资源清理；详见 [宿主命令记录](host-command-validation.md)。
各包结论不自动继承下表其他旧包的结果。

2026-10-10 清理调整：用户要求采用官方浏览器，已移除自编译浏览器路线及构建材料。下表的原生补丁 / 编译工具项目只代表历史实验，不是现有产品能力或后续交付前置；原报告与失败结果保留，说明见 [归档记录](browser-native-patch-validation.md)。核心隔离、防泄漏、资料、桥接和恢复代码继续保留，剩余工作见 [当前状态](project-status.md)。

## 已有实际证据

| 项目 | 当前证据 | 适用范围 |
| --- | --- | --- |
| 自动测试 | 本轮完整运行 103 项通过，构建通过 | 新增实际设备故障 / 恢复证据拒绝测试，覆盖主动销毁替代崩溃、设备 / GPU 未改变、画布空白、实例替换和恢复时保护失效；既有 Worker 画布、真实线程编号、运行中检查和原始证据拒绝测试保留通过 |
| 原生浏览器补丁准备 | `chromium-native-patches.json` 与 `chromium-native-patches-evidence.json` 通过；新增工具后应用构建通过 | 固定官方版本的 15 个源码文件、7 个改动文件，两补丁在独立副本重新应用且逐文件一致；仅源码准备与复核，未编译 / 未实测 / 未加入生产，字体与故障后画布仍未解决。[范围](browser-native-patch-validation.md) |
| 浏览器编译路线基础检查 | `chromium-compiler.json` 03:17:55 UTC、`chromium-compiler-guest.json` 03:19:33 至 03:20:53 UTC 通过 | 实际官方 Mac Clang / LLD 生成 Linux ARM64 ELF；新严格透明 VM 中原文件哈希相同、dev UID 502、实际输出和退出成功，前后防护有效且完整性已核验，临时 VM 清理。仅无库小程序，不是浏览器 / 原生补丁已编译或网络抓包验收；初次版本校验失败另存，完整构建路线仍未确认。[范围](browser-native-patch-validation.md) |
| 旧绘图回调保护准备 | `chromium-callback-patch.json` 与 `chromium-callback-patch-evidence.json` 通过，独立复核 03:57:30 至 03:57:32 UTC；`chromium-full-source-patches.json` 04:12:38 至 04:12:42 UTC 通过 | 从固定官方源码重新应用原绘图通道补丁及回调保护，五文件结果一致，临时复核目录清理；后续已接入真实完整源码并校验七个最终文件。两个对象释放回归未编译 / 未运行，能力仍未通过。[范围](browser-native-patch-validation.md) |
| 完整浏览器构建准备 | `chromium-build.json` 03:28:19 至 04:12:19 UTC，完整门禁失败 | 实际固定源码、全部官方依赖同步和 hooks 已完成；GN 在官方 Mac SDK 检查失败，当前 Command Line Tools 不能运行所需 Xcode 检查。原始日志和匹配哈希的旧准备脚本保留；尚未编译任何原生浏览器目标，不是签名缺失导致。[记录](browser-native-patch-validation.md) |
| Linux 编译器备用检查 | `chromium-rosetta.json` 04:04:08 至 04:08:21 UTC 通过 | 官方 Linux x64 Clang / LLD 在新严格 VM 通过 Rosetta 运行，实际 dev UID 502 编译并执行原始 ARM64 小程序，输出 / 退出 / 前后防护完整性通过，VM 清理；固定 ARM64 GN / Siso 包存在性另有官方查询结果。不是完整依赖 / GN / Rust / 浏览器构建，也不是物理抓包验收。[范围](browser-native-patch-validation.md) |
| 三类 Worker WebGPU | `browser-webgpu-host-all-contexts.json` 01:51:01 至 01:51:02 UTC；`browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts.json` 01:51:00 至 01:56:21 UTC 通过 | Mac 对照与 Linux 候选四阶段，页面 / 普通 Worker / 两个共享实例连接 / ServiceWorker 的实际计算、纹理、设备与特性一致；页面画布、重开 / VM 重启 / 保护故障拒绝与恢复通过，每阶段 17 图形线程、15 次保护采样。批准代理 683 包、未批准 0，VM 清理；原始结果 / PNG 像素 / 源码 / 线程 / pcap 独立复核通过。不是 Worker 画布或运算时线程采样、生产 / 包内 / 长期验收。[专项范围](browser-webgpu-worker-validation.md) |
| Worker 画布与绘图中保护 | `browser-webgpu-host-all-contexts-worker-canvases.json` 02:04:27 至 02:04:42 UTC；`browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases.json` 02:14:22 至 02:20:40 UTC 通过 | 三类 Worker 真实 DOM 转移画布，Linux 四阶段共 1,968 帧实际绘图 / 读回；各截图区域 2,432 绿 / 13,952 红，移动指纹改变。20 次绘图中采样，各次 20 图形线程及相关 renderer 线程保护、Tracing / 内核 NSpid 对应通过；另有 60 次测量后稳定检查。真实保护故障拒绝 / 恢复通过，物理批准代理 712 包、未批准 0，VM 清理；02:21:00 至 02:21:01 UTC 准确源码 / 原始结果 / PNG / 线程 / pcap 独立复核通过。首次失败保留，不是瞬时、生产 / 包内、强制设备故障或长期验收。[专项范围](browser-webgpu-worker-canvas-validation.md) |
| 浏览器运行中防护 | `browser-runtime-monitor.json` 01:41:55 至 01:45:28 UTC；`browser-runtime-monitor-packaged.json` 01:42:06 至 01:45:38 UTC 通过 | 两台全新 VM 的源码 / 包内服务分别自动拒绝实际未保护图形进程；进程组外浏览器不误报，约 10.76 / 10.14 秒撤销画面 / 终端 / 桥接并停机，显式恢复及旧凭据拒绝通过。各 10 次健康与 1 次实际拒绝检查，批准代理 15,557 / 15,863 包、未批准 0，VM 清理；准确源码 / 编译模块 / 截图指纹 / 原始线程 / pcap 独立复核通过，不是瞬时保护或实际 Electron UI 验收。[范围与失败记录](browser-monitor-validation.md) |
| WebGPU 实际设备故障 | `browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases-device-loss.json` 02:36:52 至 02:44:20 UTC 完成，完整门禁失败 | 四阶段 GPU 实际崩溃 / PID 改变、四类原生设备 unknown、旧设备拒绝及新设备绘图 / 读回通过；恢复中 20 次原生保护 / 线程关联通过，每次 19 图形线程。页面画布恢复，但三类 Worker 原画布始终空白；普通 Mac Chrome 同样复现。批准代理 978 包、未批准 0，VM 清理；准确源码 / PNG / 线程 / pcap 独立复核证据有效、能力失败。原正常画布证据复核仍通过，不能写成原地恢复已支持。[失败与范围](browser-webgpu-device-loss-validation.md) |
| 运行中防护包完整性 | `package-integrity-browser-monitor-candidate.json`，01:42:06 UTC 起通过 | `release/browser-monitor-candidate`，CDHash `aac47dea48dabb4413e4cfc337a5e9c5cf74e061`，6031 个封装资源完整临时签名、依赖和篡改拒绝通过；六个防护编译模块与当前构建一致。不是 Apple 开发者签名，也未继承其他包的全部 UI / CLI / 事务验收 |
| 浏览器七类上下文 | `browser-contexts.json`，`passed: true`，20:17:35 至 20:22:38 UTC | 全新两 VM、日 / 美设置、六阶段共 42 次测量，真实三类 Worker / 跨站 iframe / 新窗口、字体 / Canvas / 请求头、ServiceWorker 缓存隔离和重启持久化、四份抓包通过；WebGL 不可用，详见 [专项记录](browser-context-validation.md) |
| 历史二维媒体 | `browser-media-before-software-gl.json`，2026-10-09 22:52:54 至 22:57:22 UTC | 原二维配置六阶段观察与防护通过，完整门禁当时失败 Worker 晚注册字体与 WebGL；保留原报告，不能覆盖新绘图配置 |
| 当前软件 GL 媒体 | `browser-media.json`，2026-10-10 00:30:35 至 00:35:45 UTC；00:36:34 UTC 独立复核 | 全新两用户 VM、六阶段与 42 次字体 / 24 组音频，字体就绪首次绘制 / 离线音频 / 七类上下文 WebGL 均通过；28 个 renderer / 365 个线程、6 个图形进程 / 72 个线程保护通过，无图形崩溃，六次 Normal 退出。四份抓包批准代理 29,697 包、未批准 0，VM 清理。完整门禁仅失败晚注册字体，measurementCompleted=true、passed=false。[专项记录](browser-media-validation.md) |
| 图形防护启动拒绝 / 恢复 | `browser-sandbox-guard.json` 通过，22:51:21 至 22:51:59 UTC | 生产二维配置真实像素、每线程隔离和三次稳定采样；故意关闭图形 sandbox 后实际 11 个线程 seccomp=0，生产检查拒绝、服务停止 / 密码删除，目标保持空白页；恢复正常配置成功。物理批准代理 400 包、未批准 0；不是 3D 通过 |
| 包内已编译图形防护 | `browser-sandbox-guard-packaged.json` 通过，22:53:37 至 22:56:33 UTC；`browser-sandbox-evidence.json` 22:58:42 UTC 独立复核通过 | 全新 VM，实际 9a3c9d0 包内已编译服务 / 启动器运行同样二维与故障拒绝 / 恢复；物理批准代理 490 包、未批准 0。代码 / 截图 / pcap SHA256、签名、真实包解析重新复核，临时 VM 清理；明确没有操作实际 Electron UI 或验收 3D。[专项记录](browser-gpu-validation.md) |
| 软件 GL 与真实保护故障 | `browser-gpu-production.json` 00:14:45 至 00:17:37 UTC；最终 `browser-gpu-production-packaged.json` 00:31:22 至 00:34:38 UTC 通过 | 原源码配置和最终 627da40 包内已编译服务分别在全新 VM 验 WebGL / WebGL2 三角形像素、15 次各线程保护采样、真实关闭 GPU sandbox 的导航前拒绝 / 密码撤销 / 恢复；批准代理分别 478 / 439 包、未批准 0，VM 清理。最终包含二维软件绘制和安装延后重启修复；不是实际 Electron UI / 完整媒体 / WebGPU 验收 |
| 新软件 GL 包完整性 | `package-integrity-webgl-canvas-candidate.json`，passed=true，00:31:21 UTC 起 | `release/webgl-canvas-candidate`，CDHash `627da4002ec1329755f3fe96bd7432299250c541`；6031 个封装资源完整临时签名、篡改拒绝和包内依赖通过。未继承旧包 CLI / 快照事务 / 全部桌面 UI 结论 |
| 实际 WebGPU 与本机对照 | `browser-webgpu-host.json` 00:46:58 至 00:46:59 UTC 通过；`browser-webgpu-production.json` 00:42:39 至 00:45:31 UTC 完成但未通过 | Mac Chrome 页面 / DedicatedWorker 的实际计算、三角形纹理读回、重复 / 变参和像素一致通过；原样 Linux 生产接口存在但默认适配器为空。Linux WebGL / 隔离 / 故障拒绝与恢复通过，批准代理 515 包、未批准 0，VM 清理。新增宿主复核器的两项错误计算 / 空白 / 无变化 / 设备丢失拒绝测试通过。不是 Linux WebGPU 已支持，详见 [专项记录](browser-webgpu-validation.md) |
| 软件 WebGPU 离屏候选 | `browser-webgpu-dawn-diagnostic.json` 00:51:17 至 00:55:24 UTC，离屏实验门禁通过 | 页面 / DedicatedWorker 正确计算、纹理三角形与 15 次保护采样通过，批准代理 635 包、未批准 0；随后候选四次受测启动 / 浏览器重开 / VM 重启 / 故障后启动的真实画布均空白，完整生命周期失败。不能将纹理读回作为画布呈现证明 |
| WebGPU 呈现后端 | 四组 `browser-webgpu-presentation-diagnostic.json` 完成但失败；追加三组 `browser-webgpu-presentation-diagnostic-swiftshader-vulkan.json` 的 Graphite 组通过 | Graphite / 自带 SwiftShader 组真实计算、纹理、原生画布截图红 / 绿像素及移动变化、WebGL、17 个图形线程和 15 次保护采样通过；批准代理 621 包、未批准 0，VM 清理。独立 `*-evidence.json` 重新复核准确源文件、PNG 像素、线程和 pcap；原矩阵仍保留失败。不是生产 / 完整生命周期 / 包内 / 长期验收，见 [专项记录](browser-webgpu-validation.md) |
| WebGPU 候选生命周期 | `browser-webgpu-candidate-lifecycle-swiftshader-graphite.json` 01:13:36 至 01:18:40 UTC 四阶段通过 | 每阶段原生画布 / 计算 / WebGL / 启动保护与 15 次采样通过；实际 browser reopen、不同 boot_id 的 VM 重启、关闭保护后的拒绝 / 凭据撤销、候选恢复通过。批准代理 689 包、未批准 0，临时 VM 清理；独立准确源码 / PNG / 线程 / pcap 复核通过。未加入生产，候选媒体后续记录见下一行，包内 / 长期另验 |
| Graphite 候选媒体 | `browser-media-graphite-candidate.json` 01:18:51 至 01:24:06 UTC 六阶段完成，完整 `*-acceptance.json` 失败 | 两台新 VM、七类上下文与 28 个 renderer / 365 个线程、6 个图形进程 / 96 个线程保护、就绪字体 / 音频 / WebGL / 资料持久化分项通过；四份 pcap 批准代理 17,872 包、未批准 0，VM 清理。独立重读源文件 / 原始线程 / 字体 / 音频 / pcap 和截图指纹，完整门禁仍仅失败晚注册字体；不是生产或包内验收 |
| Linux 透明网络 | `transparent-network.json`，`passed: true`，最近运行始于 19:34:44 UTC | 许可保存失败撤销修复后的新 VM 回归，防护 v5 / gVisor；curl / Python / Git / Node、系统 DNS、HTTPS 与安装、物理抓包、直接 TCP / DNS / UDP / IPv6 拒绝、代理和隧道故障、实际隔离完成后重启，以及主动切回直接网络 |
| 内核整包隧道原型 | `wireguard-kernel.json`，`passed: true`，17:57:45 至 18:04:04 UTC | 历史阶段：真实 Linux VM 内三套隔离网络空间；内核 WireGuard / HTTP、SYN 逐字节对照、路由 / NAT、错误密钥 / 直连 / 停隧道拒绝和恢复、三份实际抓包。当时尚未接入产品网络模式；[范围与失败记录](wireguard-validation.md) |
| 整包隧道生命周期 | `wireguard-runtime.json`，`passed: true`，18:37:14 至 18:42:09 UTC | 本机测试模式；两台实际 VM、内核握手、HTTP / DNS / HTTPS、实际 eth0 抓包只含批准 UDP / SSH / DHCP、物理 DNS / UDP / TCP / 有路由 IPv6 拒绝、路由与隧道故障、错误密钥恢复、47 秒后许可过期与拒绝续回、直接模式恢复和清除私钥；不替代真实住宅对端、浏览器或 Claude 完整任务 |
| 整包隧道配置页面 | `wireguard-ui.json`，`passed: true`，18:38:19 至 18:38:20 UTC | 实际本地 API、密钥隐藏和保留、其他配置不丢失、模式切换、Mac 前提拒绝，1440 / 390 / 320 截图人工查看；不启动 VM |
| 整包隧道浏览器 / CLI 与实际包 | `wireguard-workloads.json`，`passed: true`，20:23:08 至 20:30:49 UTC | 全新两 VM 首次开机、浏览器冷安装 / 交互 / sandbox / 身份 / 持久化，源码和实际包的新窗口均通过；真实 CLI 2.1.296 工具 / PTY 中断 / 截断重试取消与恢复；同轮复跑旁路 / 路由 / 隧道 / 错密钥 / 许可故障；真正 5f30519 包运行隧道浏览器和 CLI 原生终端工具 / 中断，四份抓包独立复核通过；[精确范围](wireguard-validation.md) |
| 完整抓包独立协议复核 | `wireguard-workloads/capture-audit.json`，`passed: true`，20:31:02 至 20:31:04 UTC | 4 份文件完整可读 / SHA256，分别 186 / 58,147 / 82 / 1,083 个物理 IP 输出包；实际客体 eth0 ifindex 读取为 2，批准 UDP、SSH / DHCP 正向对照，未批准包均 0。开机文件本轮批准 UDP 为 0，工作负载和包内记录均有隧道正向对照；不替代公网 SYN 来源证明 |
| 网络与许可存储故障 | `wireguard-faults.json`，`passed: true`，19:37:05 至 19:46:26 UTC | 实际网络服务重启 / 同地址 DHCP 续租、错误系统 DNS 自动隔离、许可目录实际 ENOSPC 且宿主检查暂停时自行撤销、双向对端断线约 188.9 秒后自动停机与正常恢复；四份专项 pcap 未批准包 0；随后通用生命周期故障复跑。不是 Mac 休眠 / 切网或整盘写满验收 |
| 本机端口暴露与旧配置迁移 | `port-forwards.json`，`passed: true`，18:07:10 至 18:08:28 UTC | 实际复现旧规则自动映射所有地址 TCP / UDP；新规则与正常启动迁移均拒绝未配置的所有地址 / 回环服务，明确授权 TCP 映射仍成功；直接联网合成 VM，不替代出口 / 许可验收；[专项记录](port-forward-validation.md) |
| 严格首启动与权限 | `network-security.json`，`passed: true`，13:24:41 UTC 开始 | 真实新严格 VM 第一次用户开机抓包、无未批准 IP 出口；受信基础镜像没有账号或共享；dev 直接任意 sudo / 改网络 / 读管理密钥拒绝。此测试没有覆盖共享目录 setuid 路径，不能宣称任意提权均拒绝 |
| 完整性与停机 | 同一网络报告的 `addedAllowRuleDetectedAndQuarantined: true` | 实际插入额外允许规则仍被宿主指纹检测；关闭访问并隔离停机。不是仅检测防火墙表存在 |
| 透明路由回归 | 最新透明报告路由、DNS、规则与开机配置均就绪，`integrity: verified` | 修复首次抓包服务与 networkd 的停止依赖后，普通程序和重启回归通过 |
| 网络服务升级与路由保留 | `networkd-policy.json`，`passed: true`，15:57 UTC 开始 | 真实 networkd 重启和 systemd / resolved 8.16→8.17 升级，9 条代理路由规则保持、普通 curl 经 TUN 成功；首次开机抓包摘要未变；不安全策略权限触发停机，重启迁移后用户标记保留 |
| 宿主桥接 | `host-bridge.json`，`passed: true` | 实际 VM 读取明确授权文件、拒绝路径穿越 / 符号链接 / 未授权写，显式原子写、撤销与停机撤销；未增加网络例外 |
| 离线快照 | `snapshots.json`，`passed: true`，20:48:52 至 20:52:02 UTC | 真实磁盘恢复及恢复进程 / 回滚进程 SIGKILL、回滚清理部分中断、配置保存后未提交、提交后退出的正常生命周期恢复；磁盘与配置一致、宿主项目保留、损坏快照拒绝、临时 VM 清理通过。源码管理器实测，非实际整机断电或现有候选包验收；[专项记录](snapshot-recovery-validation.md) |
| 快照范围界面 | `snapshot-scope-ui.json`，`passed: true` | 1440 / 390 / 320 布局实测，Linux 浏览器资料随磁盘保存、旧本机浏览器资料不包含；使用临时配置，不启动 VM |
| 加密备份实际迁移 | `portable-backups.json`，`passed: true`，21:25:56 至 21:29:00 UTC | 实际严格 VM 停机导出并导入独立数据目录；新管理密钥与 VZ 身份、无宿主共享授权、旧密钥实际 SSH 登录拒绝、root 旧授权正向夹具清空、数据和合成浏览器资料保留；首次开机 203 个物理 IP 输出无未批准包，正常重启通过；无账号，非第二台 Mac 或真实浏览器登录迁移；[专项记录](portable-backup-validation.md) |
| 加密备份界面 | `portable-backups-ui.json`，`passed: true`，21:15:39 至 21:15:40 UTC | 实际本地 API 的小型磁盘导出 / 导入、密码确认、路径选择回调、成功任务，1440 / 390 / 320 截图；不代替 Electron 原生文件对话框或实际 VM 验收 |
| 实际浏览器资料备份迁移 | `portable-backup-browser.json`，`passed: true`，21:33:51 至 21:38:11 UTC | 全新严格 VM 的 Chromium 正常保存持久 HttpOnly Cookie、localStorage / IndexedDB；独立数据目录导入与 VM 重启后均直接识别合成登录，登录请求仅 1 次，语言 / 时区保留，首开 199 个物理 IP 输出未批准 0；不是第二台 Mac 或真实服务账户迁移 |
| 桌面包实际备份恢复 | `portable-backup-packaged.json`，`passed: true`，21:38:47 至 21:46:52 UTC；包内阶段 `packaged-backup-browser.json`，21:43:55 至 21:46:52 UTC | 同轮重新创建源 VM / 浏览器冷安装，源码独立目录导入首开 195 包无未批准输出；实际 1b1ef56 包从界面创建快照 / 加密导出 / 导入，启动新 VM / 浏览器与重启保留三类合成网站数据，总登录 1 次，三次 1280×800 真实画面非空。包内浏览器工作负载物理 IP 输出 412 个、批准代理正向对照 140、未批准 0；已清理测试 VM / 数据。路径在界面输入，原生文件对话框、第二台 Mac、真实账户、快照事务故障另验 |
| 无账号实验室 | `account-free-lab.json`，`passed: true`，付费调用 0 | DNS / STUN 正向对照、双合成登录隔离、模拟模型流与工具任务、异源及真实凭据拒绝；成功发现其测试浏览器的 Worker 语言不一致 |
| 历史真实 Claude Code 无账号客户端 | `claude-client-before-tui-fixture.json`，`passed: true`，17:33:38 至 17:35:33 UTC | 实际 dev 用户 CLI 2.1.295、分段流式工具 JSON、Write / Read / Bash、取消后连接与进程退出、忽略 SIGTERM 的进程超时终止、截断工具输入后的重试取消与新任务恢复；两份物理抓包 212 / 184 包。断线后观察到自动重试，不宣称自然最终失败；[范围与失败记录](claude-client-validation.md) |
| Claude Code 基本交互界面 | `claude-tui.json`，`passed: true`，23:37:39 至 23:40:17 UTC；独立复核通过 | 全新严格透明 VM、真实 CLI 2.1.296、生产网页终端；拒绝 Write 后无文件、单次授权 Write / 写文件 Bash、三个工具实际结果、Escape 后同 PID 继续、退出并恢复 5→6 轮历史、关闭页面后 guest CLI / 响应 / 宿主 PTY 清理。955 个物理 IP 输出 / 批准代理 451 / 未批准 0；数据已清理。使用官方演示模式和合成本地网关，首次账号设置未验；本项为透明代理，隧道单列；[专项记录](claude-client-validation.md) |
| 实际包 Claude Code 基本交互 | `claude-tui-packaged.json`，`passed: true`，23:42:08 至 23:44:32 UTC；23:45:16 至 23:45:17 UTC 独立复核通过 | 实际 7d6e3ea Electron 应用通过包内入口创建全新 VM / 冷安装 CLI；实际窗口 renderer 系统沙箱启用、隔离配置有效。原生终端拒绝 / 单次授权、同 PID 恢复、历史恢复和关闭清理通过。真实应用所属 limactl / ssh TTY 进程退出、guest CLI / 响应关闭，主窗口保留且防护检查通过。956 个物理 IP 输出 / 代理 446 / 未批准 0，临时资料已清理。第一轮另存 `claude-tui-packaged-before-os-sandbox-check`，无账号 / 付费 0 |
| 实际包 WireGuard 基本交互 | `claude-tui-wireguard.json`，`passed: true`，23:51:02 至 23:54:05 UTC；23:55:37 UTC 独立复核通过 | 实际 7d6e3ea、新建受保护客户端、包内冷安装 CLI 2.1.296、独立 VM 内核 WireGuard 对端。公网双向转发已阻断，固定本地模拟接收源为 10.77.0.2，拒绝计数 15 包。实际拒绝 / 单次授权、同 PID 恢复、5→6 轮历史恢复、关闭后宿主 TTY / 客体 CLI / 响应退出且防护有效。开机 / 任务 216 / 981 个物理 IP 输出、对端 UDP 2 / 454、未批准均 0，临时 VM / 目录已清理；无账号 / 付费 0，不覆盖住宅对端或全部工具 / 故障 |
| 多轮修复后的 print 回归 | `claude-client.json`，`passed: true`，23:25:16 至 23:28:27 UTC | 另一台全新严格 VM、CLI 2.1.296；三个工具、任务引擎取消 / 进程退出、忽略 SIGTERM 的任务超时清理、两次截断后主动取消重试与新任务恢复。物理抓包 214 / 188 包仅批准出口，无账号 / 付费 0；不能把主动取消写成自然最终失败 |
| 旧本机浏览器身份 | `native-lab.json`，`passed: true`、`consistent: true`，付费调用 0 | 纽约英语与东京日语，页面 / Worker / iframe / 请求头、Client Hints、真实 CPU / GPU / Canvas；不宣称平台或 GPU 已伪装 |
| Linux 浏览器界面状态 | `guest-browser-ui-states.json`，`passed: true` | 1440×960 / 390×844，停止与连接失败状态、透明网络前置限制；使用模拟 API，不是实际 VM 帧证据 |
| Linux 浏览器实际运行 | `guest-browser.json`，`passed: true` | Chromium 156.0.8078.4 实际 Linux 画面与 Canvas 像素、鼠标 / 键盘、页面 / Worker / 请求头；renderer seccomp、no-new-privileges 与独立 PID namespace；认证画面、管理页面拒绝、代理断线无回退、物理抓包仅代理 / SSH / DHCP |
| Linux 浏览器资料 | `browser-profiles.json`，七阶段 `passed: true`，14:42:34 UTC 开始 | A / B 的持久 HttpOnly Cookie、localStorage、IndexedDB 隔离；正常关闭与两台 VM 重启后保留；页面 / Worker / 同源 iframe / 请求头语言与时区一致；不同磁盘与 machine-id、资料权限 0700 |
| 全新 Linux 浏览器冷安装 | `browser-profiles-cold-fixed.json`，七阶段 `passed: true`，15:55:22 UTC 开始 | 默认生产路径，两套新磁盘首次 apt 安装、导航及双环境资料 / 重启验收通过；5 次正常退出均 Normal；安装前后防护有效、dev 路由经 TUN、无代理变量 curl 成功；首开 A / B 174 / 172 个物理输出包仅批准代理 / SSH / DHCP，无物理 IPv6 |
| 忙任务监测后的冷安装回归 | `browser-profiles-egress-regression.json`，七阶段 `passed: true`，16:30:59 至 16:35:52 UTC | 两台全新 VM 默认生产路径安装、资料隔离与重启保存再次通过；未启用出口批准，专门验证后台监测覆盖忙任务后未破坏安装流程 |
| 内核许可与 gVisor 的冷安装回归 | `browser-profiles-lease-regression.json`，七阶段通过，16:59:10 至 17:03:39 UTC | 两台全新用户 VM 与基础镜像，默认生产安装、资料隔离 / 保存和五次 Normal 退出通过；首开 A / B 199 / 216 个物理包仅批准代理 / SSH / DHCP，无物理 IPv6 |
| HTTPS 加密上游 | `encrypted-upstream.json`，`passed: true`、`actualLinuxVmVerified: true`，17:05:29 UTC 开始 | 防护 v5 / gVisor，TLS 1.3、SNI、认证 CONNECT，明文请求 / 响应经加密上游；双向物理抓包；错误 CA / 名称 / 凭据与断线拒绝；独立直接模式明文正向对照；6 份抓包保留 |
| HTTPS 配置界面 | `https-ui-verification.json`，10 项通过 | 320 / 390 / 桌面尺寸，模式、名称与 CA 保存、严格透明前提和本机模式拒绝；模拟服务和接口验证，不是 VM 网络证明 |
| SOCKS5 认证与故障 | `socks-upstream.json`，`passed: true`，21:59:34 至 22:02:50 UTC；独立 `socks-upstream/capture-audit.json` 通过 | 两台真实 VM，独立宿主 curl 认证正反对照；特殊字符账号 / 密码、普通 curl / Python、系统 DoH / 真实 HTTPS、错误 / 缺失凭据、无认证服务、错误 DoH 名称、代理停止 / 恢复 / VM 重启；七阶段 543 个物理 IP 输出，批准代理 151、未批准 0；无账号 / 付费 0。普通 SOCKS 凭据和 HTTP 明文可见；[范围与失败记录](socks-upstream-validation.md) |
| 出口核验与变化停机 | `egress-constraint.json`，`passed: true`、`actualLinuxVmVerified: true`，17:01:56 至 17:05:58 UTC | 防护 v5 的真实 VM / TUN / TLS、合成 A / B 回应；启动不匹配、忙任务后台变化、终端与桥接撤销、错误 TLS / 回应 / 服务丢失、数据保留及五份物理抓包通过；本轮变化至停机 10700 ms，不是最大时延承诺或住宅线路证明 |
| 应用故障内核自动断网 | `guest-lease.json`，`passed: true`、`actualLinuxVmVerified: true`，16:59:58 至 17:02:54 UTC | 实际管理子进程 SIGKILL、长连接双向正向对照后收发停止、新连接拒绝、VM / 管理仍运行、过期会话不可恢复、持久后台程序重启前拒绝和正常退出撤销；306 个物理输出包仅批准出口。激活前两次真实生产 TLS / DoH 测量成功；休眠另验 |
| 出口批准界面 | `egress-ui.json`，七项通过 | 显式输入、保存与其他设置保留、运行时只读、异常状态、320 / 390 / 桌面布局；模拟运行状态，不代替实际 VM 证明 |
| 克隆主机名与旧环境修复 | `hostname-security.json`，`passed: true` | 新受保护基础镜像克隆、两次重启、模拟旧环境缺失策略后修复；本机名称仅回环解析，Lima 网关和 DNS 保留；首开 144 个物理出站包仅批准代理 / SSH / DHCP，dev 提权及直连仍被拒绝 |
| 原候选包完整性 | `package-integrity-before-portable-backups.json`，`passed: true`，20:20:03 UTC 起 | 0.4.0 adhoc、5906 个封装资源、deep / strict 与篡改拒绝，实际 STUN、Messages / 两类截断和编译 WireGuard 配置；CDHash `5f305193359bcbe113e07dc86d944236da327101`。实际 VM 任务由独立上行报告证明；不是开发者签名 / 公证 |
| 备份包完整性与归档 | `package-integrity-backup-candidate.json`，`passed: true`，21:29:28 UTC 起 | `release/backup-candidate`；CDHash `1b1ef56dff28a2b8199b5d74af5027cbbc205667`，6030 个封装资源；实际包内合成磁盘加密往返、错误密码拒绝、新 Store 密钥与端口清除、STUN / Messages / WireGuard 配置、deep / strict 与篡改拒绝。实际 VM 浏览器 / 备份由上行独立报告证明；该包 CLI / 快照事务故障和原生文件对话框另验 |
| 图形防护包完整性 | `package-integrity-graphics-candidate.json`，`passed: true`，22:53:38 UTC 起 | `release/graphics-candidate`，CDHash `9a3c9d0eff7b0f8182c02953848cbd2f12e17eef`，6031 个封装资源；完整 deep / strict、资源篡改拒绝、包内 STUN / Messages / WireGuard 配置及合成备份往返通过。真实包内 VM 图形任务见独立上行报告；未将旧包桌面 UI / CLI / 快照故障证据转移给此包 |
| 多轮模拟服务候选包 | `package-integrity.json`，`passed: true`，23:26:53 UTC 起 | `release/tui-candidate`，CDHash `7d6e3ea1d0b2b22ec466c2f1652279e5ca7bc37e`，6031 个封装资源；deep / strict、篡改拒绝、实际包内多轮 / 合并拒绝 Messages、两类截断、STUN、WireGuard 配置、合成加密备份往返通过；实际 Electron TUI 另有独立验收，不代表全部 VM / 恢复流程已重验 |
| 原透明模式包运行 | 历史 `packaged-guest-browser.json`，`passed: true`，18:44:37 至 18:45:25 UTC，CDHash `4a52bba2ddc343153ad2a725f49216720aa7f407` | 该旧包的原生 PTY / dev、1280×800 浏览器、键鼠、身份、关闭撤销 / Normal / VM 停机及 v5 迁移；不把旧包报告写成当前包回归。当前包实际 WireGuard 任务见上方新增报告 |

最新 JSON 的 `startedAt` 使用 UTC，界面显示时间可能采用本地时区。网络首启动测试与透明测试分别覆盖不同路径；首启动报告不是任意未来修改基础镜像配方都自动继续通过的凭证。

新增快照恢复修复与加密备份已进入源码、本地预览及 `release/backup-candidate` 的 `1b1ef56` 新包。原候选 `5f30519` 保留不变，不包含这些新增功能。原包的既有实际 VM 网络和浏览器记录保留其适用范围；新包已有独立实际 VM 浏览器 / 加密备份 / 重启与工作负载抓包证据，不能直接继承原包的全部实际 VM / CLI 故障结论。

最新图形防护实现另打包为 `release/graphics-candidate` 的 `9a3c9d0`；保留前述功能，新增独立包内已编译服务的真实 VM 二维防护 / 故障拒绝 / 恢复证明。本轮没有重跑全部桌面 UI、CLI 或快照事务故障，不将旧包记录自动归入新包。

新增多轮模拟服务修复打包为 `release/tui-candidate` 的 `7d6e3ea`。包内接口、依赖和完整性，以及实际 Electron 原生终端的基本交互均有独立通过记录；后者通过包内入口创建全新 VM 并冷安装 CLI。源码基本 TUI 和 print 回归另有全新 VM 报告；上述范围不等同新包全部 VM / 工具 / 恢复功能已验收。

## 保留的失败与区别

| 实验 | 结果 | 处理 |
| --- | --- | --- |
| Mac 单进程限制 | `mac-policy.json` 通过 | 仅覆盖被启动进程及继承子进程；TCP / UDP / IPv6 有正向对照，代理故障无直连回退。不是浏览器或系统扩展验收 |
| Mac Chromium 联合限制 | `mac-browser.json` 的 `passed: false` | 实际错误为 `sandbox initialization failed: Operation not permitted`，网络服务失败并出现 `ERR_FAILED`。保留报告，不关闭 Chromium renderer sandbox 来声称通过；本机严格浏览器功能未开放 |
| 独立 Mac Chrome 联合限制 | `mac-chromium.json` 的 `passed: false`，17:47:29 至 17:47:42 UTC | 全新资料的普通代理 / 页面 / Worker / Canvas 正向对照成功；放行必要单实例 Unix socket 绑定后，内部 sandbox 初始化仍失败，网络 / GPU 进程失败并超时。不是 Electron 独有问题；[范围与前置失败](mac-browser-enforcement-validation.md) |
| 实验室测试浏览器一致性 | `account-free-lab.json` 的 `testBrowserConsistent: false` | Worker 语言与页面不同，被检测器发现。实验室通过表示检测与测试服务有效，不表示该测试浏览器一致；随后旧本机产品浏览器由独立 native-lab 验证通过 |
| 浏览器资料正常关闭 | `browser-profiles-before-fix.json` 失败 | 旧停止次序导致 Cookie / localStorage 丢失；改为先请求 Chromium 保存并正常退出后，完整七阶段重跑通过 |
| 浏览器首次安装导航 | `browser-profiles-cold.json` 失败，`browser-profiles-cold-network-state.json` 已定位，修后独立报告通过 | 首次 apt 安装升级并重启 systemd-networkd，删除透明代理策略路由；Chrome 和安装后的 curl 均改走 eth0，被默认拒绝防火墙阻断。预置路由保留策略后，全新 A / B 七阶段、实际网络服务重启及系统升级均通过 |
| 浏览器新窗口关闭 | `browser-contexts-before-native-identity-fix.json` 捕获真实 locale override 冲突 | 同一 renderer 的新窗口重复覆盖语言导致整体关闭；改用原生启动语言 / 时区后，七类真实上下文六阶段通过，保留失败记录 |
| 网页字体与进程读取 | `browser-media-before-worker-font-readiness.json` 首次真实差异；两个 proc 读取失败报告与抓包保留 | 三类 Worker 的旧字体名称在下载后仍用替代字体，普通 Mac Chrome 亦复现；另验字体就绪后首次绘制通过，不能替代原差异。修复 NUL 分隔与 Chromium 单字段进程标题解析后，六阶段实际进程检查完成，仍保留完整门禁失败而非抹去已发现问题 |
| 图形后端与截图 | `browser-gpu-before-production-hardening.json`、`browser-media-before-graphics-hardening.json` 与 `browser-media-before-foreground-capture.json` 保留 | 默认图形 seccomp=0，提前 sandbox 的初次尝试图形崩溃，新增 Vulkan 驱动仍没有合格 3D；改为明确受保护二维配置。后台标签页截图超时改为先切到前台后完整六阶段重测，没有忽略失败或将 WebGL 不可用写成通过 |
| 字体就绪及原生语言误报 | `browser-contexts-before-font-readiness-fix.json`、`browser-contexts-before-native-identity-acceptance.json` 与 `wireguard-workloads-before-native-inspection-fix.json` 失败 | 系统字体测量去掉不适用的加载等待；原生 `ja` 与网页 `ja-JP` 按语言和可用地区检查，跨上下文仍要求完全相等；错误语言 / 地区 / 时区反向测试通过。综合任务的旧进程使用了修复前模块，已独立重跑 |
| 候选包启动依赖 | 重打包前启动失败；当前报告来自修复后复测 | STUN 和 binary-data 的内置 src/node_modules 被默认打包排除；显式纳入运行文件后，安装包 STUN 正向对照和真实桌面流程通过。旧失败 JSON 已被复测覆盖，不将新报告称为历史失败证据 |
| 浏览器旧崩溃标记 | `packaged-guest-browser-before-close-fix.json` 的退出字段为 Crashed；正常关闭结论当时过强 | Chromium 在用户未确认旧恢复提示时保留旧标记；真实鼠标确认后两次关闭均 Normal，随后默认复测无需确认也均 Normal。没有修改偏好、清资料或隐藏提示。详见 [打包浏览器验收](packaged-browser-validation.md) |
| 出口验收抓包 | 三份旧脚本诊断报告保留；其中 `egress-before-strict-capture-check.json` 的历史绿色无效，已标记 `evidenceValid: false` | 修复抓包落盘、停机错误吞掉断言和 TUN / 物理接口混计；最新报告强制五份抓包、无捕获错误及实际停止。详见 [出口核验验收](egress-validation.md) |
| 内核许可验收 | 抓包导出、默认 system 栈的检测超时、物理字段空格解析失败均独立保留 | 硬退出关键断网行为不能代替完整测试通过。默认栈改写连接已由抓包定位，换内置 gVisor 后完整复测通过，详见 [专项记录](guest-lease-validation.md) |
| 透明故障脚本恢复 | `transparent-before-quarantine-wait.json` 失败 | 工具 / 抓包 / 故障拒绝已通过，但脚本在真实后台隔离进行中立即重启；修改为等待隔离完成并核对 VM 停止后恢复，不能关闭监测来换取通过 |
| 故障专项抓包复核 | `wireguard-faults-before-bpf-fix.json` 失败 | 网络重启 / 续租和防护摘要检查成功，但 Mac tcpdump 拒绝过滤表达式；明确使用协议与地址条件后，从全新两 VM 重跑通过，没有放宽批准流量 |
| SOCKS 测试服务准备与抓包方向 | `socks-upstream-before-listener-readiness.json`、`socks-upstream-before-capture-direction-fix.json` 失败 | 等待独立 curl 实际连通后才进入测试；由仅输出采集改为双向，出站政策仍单独严格复核。完整重新运行和独立七阶段抓包复核通过；失败抓包保留，没有放宽产品网络规则 |

旧 `packaged-verification.json` 和 `desktop-verification.json` 对应此前 0.3.0 包，不作为当前候选证据。0.4.0 的包完整性和真实桌面证据分别见上表两份新报告；后续修改并重打包后仍须重新验证最终生成的应用。

浏览器冷启动的根目标过滤、renderer ready、关闭 GPU 和 Page.enable 对照没有解决首次安装后的导航超时；网络日志与安装后 curl 进一步定位到 networkd 删除透明代理策略路由。默认拒绝防火墙保持生效，记录 161 个阻断包，没有因此开放直接出口。生产路径已预置路由保留策略，增加组件准备后的网络防护复核，失败时不启动浏览器；四项初始化回归通过，包括这一阻断入口。修后默认生产路径的全新冷安装验收通过，没有采用 Chrome 试验开关。正常关闭仍等待浏览器自然退出再停止显示服务；防护隔离停机不等待这一正常保存路径。

## 账户与本地环境

此前保留的“MuCodeSandbox 开发环境”为 2 CPU / 2 GB / 20 GB，示例项目只读映射。旧环境已安装 Claude Code 2.1.295，但没有用户登录记录或模型调用验收。本轮新任务使用 dev 用户，旧 mu 用户下的 CLI 安装不代表 dev 账户已装好 CLI，也不会自动迁移账户资料。

后续桌面验收脚本默认不安装或检查 Claude；仅显式设置 `MU_TEST_CLAUDE=1` 才启用该安装检测。可先用模拟模型和工具任务验收文件、进程与网络路径，再由用户自行决定真实账号登录。

## 尚未证明

- 用户住宅出口或商业 SOCKS5 线路的稳定性、地区和断线行为，以及代理域名地址变化；受控 HTTP / HTTPS / SOCKS5 与 WireGuard 本地服务已有协议及故障证据。SOCKS5 本轮没有运行浏览器 / CLI 或实际桌面包。
- Linux 浏览器完整媒体：软件 WebGL / WebGL2、保护故障与新源码配置六阶段分项通过，完整门禁只剩 Worker 晚注册字体；WebGPU、真实音频设备、公网字体 CDN 和长期性能另验。不能把这一项差距写成整个项目只剩一项，也不能把图形 seccomp 证明扩展为所有进程与 renderer 的全部隔离机制相同。
- 每一个业务连接的固定最终公网出口；核验与变化停机的合成回应不证明公网分流和住宅线路。客体许可到期、管理器硬退出和首次核验前持久任务已有独立实测。HTTPS 上游 TLS 已实测，普通 HTTP / SOCKS5 仍明文。详见 [出口核验验收](egress-validation.md)。
- 多小时连续运行、休眠、Wi-Fi 切换、地址变化等更多网络故障和整盘写满恢复；网络服务重启 / 同地址续租、错误 DNS、许可目录 ENOSPC 和持续对端断线已有专项证据，不能扩大为所有故障均已验收。
- 客体 root 无法在宿主监测停机前建立旁路；当前防火墙位于客体，dev 无任意 sudo，宿主监测不能替代客体之外的强制网络边界。
- 全部快照断电路径、备份导入更多写入 / 提交中断窗口、整盘写满、第二台 Mac 和真实服务账户迁移。已验真实子进程在解密暂存后 SIGKILL、正常服务清理与重试，以及源码和实际 1b1ef56 包的真实 Chromium 合成登录 / 网站资料备份恢复；共享项目与旧本机浏览器数据不包含。包内快照事务故障和原生文件选择仍需验收。
- Claude 真实登录、在线额度、模型请求及 Claude Desktop 各种任务模式。
- 首次账号设置、更多工具子进程 / 交互模式与版本、包内截断 / 超时 / 全部故障；源码透明代理及实际 Electron 包透明代理 / WireGuard 的基本 TUI 拒绝 / 单次授权 / 同进程恢复 / 对话恢复 / 关闭清理已通过，不能扩展为所有工具与模式。
- Apple Network Extension、macOS 虚拟机、正式开发者签名 / 公证、全新 Mac、Intel 和 Windows。当前候选完整资源临时签名校验已有通过记录。

临时签名不需要开发者账号，但不能授予 Network Extension 权限。当前完整 `.app` 资源有效性由单独 deep / strict 校验和篡改拒绝实测证明，不能仅凭“有临时签名”推断。Linux VM 防护不依赖 Apple Network Extension。管理员权限、开发者账号以及组件实际加载分别是不同条件。

2026-10-10 的新增真实共享目录测试发现身份提升：4755 文件实际属于
管理用户时，dev 执行身份程序得到 `502 2000 0`。原始失败及无效对照
均保留。当前新增开机 nosuid / nodev、持久策略核验及旧共享 VM 的
安全记录门禁；最终 `shared-mounts.json` 的新 VM 首次 / 重启、有效
身份提升对照、读写 / 只读、有限安装及持久策略故障入口拒绝 / 恢复
通过，临时 VM 删除。随后旧配置样本的无共享迁移、真实管理进程
SIGKILL、pending 访问拒绝及停机、重试和原生文件保留通过；原严格
构建 VM 的同一路径及前后网络完整性另有通过记录。新增源码及
`release/shared-mount-candidate` / CDHash `5558c78` 包内已编译模块
的实际旧磁盘快照恢复通过：撤销旧共享批准和迁移日志、自动无共享
维护、首次保护 / 重启、有效身份对照和文件保留。包内模块由 Node
加载，没有操作 Electron 桌面 UI，亦没有物理抓包。新包完整临时
签名 / 6032 资源 / 篡改拒绝及基础模块验证通过。其他旧用户映射、
包内首建 / 全部迁移与快照中断窗口仍未验收，
最新 b0cd06d 包另通过真实 Electron UI 全新共享目录验收，14:47 UTC
独立复核通过：三次不同实时 boot ID、六份原始抓包、有效身份提升
对照 / 恢复、只读变更、包内全部后台模块与 PNG 核验。未批准外发
均为 0，临时资源清理。对应 `test:shared-mounts-ui-latest` 与
`test:shared-mounts-ui-latest-evidence`；失败截图轮单独保存。这项不
证明旧环境迁移、全部断电路径或系统文件选择器。14:49 UTC 独立的
`test:shared-mounts-migration-latest` 与对应 `-evidence` 又通过最新包内
全部后台模块的实际旧不安全环境迁移、中途 SIGKILL 后拒绝访问 / 停机 /
重试及旧磁盘恢复后自动修复，身份对照和数据保留通过，临时资源删除。
后者由 Node 调用模块，没有 Electron UI 或物理抓包。

新增 `test:sustained-network` / `test:sustained-network-evidence` 于
15:21 UTC 独立复核通过：最新包内模块真实 VM 两段至少五分钟持续
数字地址请求和流、代理故障阻断及恢复、networkd 重启 / DHCP 续租、
转发服务故障自动停机 / 重启恢复，四份抓包未批准外发均为 0。原始
客体 / 服务端记录、全部模块和时序核验通过，临时资源删除。先前
DNS 断言失败保留；本轮测试代理拒绝 DoH，不证明正常域名解析。
也不证明全天、浏览器、Mac 休眠 / Wi-Fi 或真实线路，见 [持续记录](sustained-network-validation.md)。

新增 `test:domain-network` / `test:domain-network-evidence` 于
15:39 UTC 独立复核通过：最新包内模块真实 VM 系统解析 / 22 个不同
域名请求、三分钟连续查询、本地 TLS DoH、未信 CA / 错名 / 服务关闭
三个故障窗口及恢复、NXDOMAIN / 物理 DNS 绕行内核拒绝 / 网络服务
重启续租，六份抓包未批准外发均为 0。全部模块 / 证书 / 回执 / 原始
文件核验及临时资源清理通过。前轮故障窗口缺失的复核失败保留；
Mac 信任库未改，不是浏览器 / 公共解析器 / 全天范围。[域名记录](domain-network-validation.md)。

详见 [共享目录专项](shared-mount-validation.md)。既有直接 sudo 拒绝
不能推断这条路径早已被保护，也不能将未更新安装包认定为包含新修复。

Linux 完整构建的闭合开机恢复与完整单线程源码扫描已实际完成；
官方 Linux ARM64 gperf 包不存在导致依赖同步失败，VM 已停止。
没有编译原生回归或浏览器，没有改变字体 / 故障后画布能力结论。

详细后续工作见 [gaps-and-validation.md](gaps-and-validation.md)。当前没有“绝对不泄漏”或“不会封号”的实验证据。
## 网络监测增量验收

cf031a2 候选的监测组件死亡 / 卡死、真实 VM 停机 / 授权撤销及手动
恢复、五份抓包和包身份复核通过；138 项源码测试通过。真实 Mac
Wi-Fi / VPN 切换、休眠与全天行为仍未验收。完整范围见
[宿主网络记录](host-network-validation.md)，不自动继承旧包全部专项。
