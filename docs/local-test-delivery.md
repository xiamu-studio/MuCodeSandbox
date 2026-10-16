# MuCodeSandbox 本机测试包

当前试用包为 **0.4.5**，安装位置 `~/Applications/MuCodeSandbox.app`。
最新样式修订构建为 `7c2737978926f345`，统一日志历史按钮并完成原生展开 / 收起检查：
[按钮交付记录](plans/2026-10-11-history-button-design.md)。
当前路径与现场状态以 [项目总览](../PROJECT_OVERVIEW.md) 为入口；下方 0.4.0
段落均为历史交付范围，其中“当前包”指该历史包，不指今天的 0.4.5。
新增沙箱浏览器真实分辨率与 Retina 密度自适配，见 [清晰度验证](retina-display-validation.md)。
新增出口定时双回执、连接 / DNS 元数据和可读日志，见 [网络日志验证](network-observations-validation.md)。
双击桌面 MuCodeSandbox 图标打开。新版包含玻璃布局、浏览资料重置、
使用指南、网络向导、真实防护状态和沙箱无账号检测。
当前包另增加本地 IP 首页和画面内打开进度，见 [首页验证](browser-home-validation.md)。
前一轮窗口适配及独立浏览器窗口见 [适配验证](layout-validation.md)。
前一轮功能验证保留在 [0.4.1 使用体验验证](usability-validation.md)。
仍为临时签名本机测试版，没有 Apple 正式签名或公证。

## 0.4.0 历史交付

以下记载的是历史试用包：`release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app`，
版本 0.4.0，Apple Silicon Mac，约 360 MiB，临时签名标识
`9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3`。
不是 Apple 正式签名或公证发行版。

2026-10-11 本机入口已补齐：安装副本位于 `~/Applications/MuCodeSandbox.app`，
桌面 `MuCodeSandbox` 快捷入口指向该副本；完整签名和同一 CDHash 核对通过，
实际双击已打开工作区。没有重建应用或启动用户 VM。
[桌面入口检查](desktop-launch-check.md) · [使用指南](user-guide.md)。

按用户 2026-10-11 最新决定，需额外设备、线路、身份或中断现场的
项目先暂缓，不阻塞本轮试用，也不记为已通过。
[暂缓事项与恢复条件](deferred-validation.md)。

2026-10-11 01:02 UTC 交付证据核对通过：13 项现有验收报告、对应
独立复核、原始文件和当前包模块一致。运行 `npm run audit:local-delivery`
可刷新 `test-results/local-delivery-audit.json`；它只核对既有范围，
不替代新的实际验收，不表示整个项目完成。全天任务已按用户要求于
00:46 UTC SIGTERM 停止，进程退出、临时 VM / 数据清理，约 45 分钟
九轮观察和两份部分抓包保留；10,229 / 6,277 个物理外发包未批准
外发均为 0。本项暂缓，未满一天，不再等待明早自动完成。

同包长期运行程序已通过 124 秒短测 / 五轮观察 / 两份物理抓包的
独立复核，未批准外发 0。完整全天任务现已暂缓，不影响现有本机
试用入口。[长期验收](day-workflow-validation.md)。

当前没有等待中的验收任务。四类 WireGuard 故障补测已经通过；实际
Mac 休眠测试在管理员认证步骤超时，未实际睡眠，临时资源已清理。
该项保留为未验证，不自动重试。[休眠记录](actual-sleep-validation.md)。

当前包选定维护开机的防护 / 抓包先于网络服务、桌面 pending 强退 /
界面重试和无 UI 迟到启动自动关闭另已独立复核。六份抓包未批准
外发 0，原文件保留，资源清理；不是全部首包 / 整机断电。
[维护验收](disk-recovery-interruption-validation.md)。

当前包受控加密 DNS / 系统解析专项另独立复核通过，22 个新域名 /
三类故障拒绝与恢复、物理绕行拒绝及六份抓包未批准外发 0；临时
资源清理、Mac 信任库未改动。不是公共 / 住宅线路或浏览器 DNS。
[系统 DNS 验收](domain-network-validation.md)。

当前包实际双 VM WireGuard 的官方浏览器 / CLI、授权 / 拒绝、取消
恢复、关闭清理、对端断线时实际页面失败 / 恢复及重启资料保留另
独立复核通过，四份抓包未批准外发 0，资源清理。真实住宅对端另验。
[隧道验收](wireguard-validation.md)。

当前包共享目录实际 UI 创建、首次 / 重启防提权、有效对照、读写改
只读后旧写入拒绝 / 文件保留另独立复核通过，六份抓包未批准外发
0，临时资源清理。[共享界面验收](shared-mount-validation.md)。

当前包 153 项源码测试 / 构建 / 完整性通过。实际 Electron 主进程
SIGKILL 时活动流与新请求阻断、终端 / 文件访问失效、所属 SSH /
PTY / 文件助手 / 监测组件全部退出，许可到期与手动恢复通过对应包
复核，三份物理抓包未批准外发 0。完整桌面浏览器 / 无账号 Claude
Code / 文件与固定 Git 授权 / 快照 / 加密导入另六份物理抓包复核
通过，未批准外发 0。临时资源清理，核心 VM 保留。
[实际强退](desktop-crash-validation.md) · [完整流程](packaged-workflow-validation.md)。

同一包 HTTPS / SOCKS5 与出口锁定组合于 23:14 / 23:19 UTC 另独立
复核通过：许可开放前测量、错误认证 / HTTPS 证书拒绝、出口变化 /
测量异常关闭与正确配置恢复；十八份客户端物理抓包未批准外发 0。
两项均为包内模块 / 真实 VM 和合成出口回执，临时资源已清理。
[代理组合范围](egress-probe-validation.md)。

当前包旧共享迁移中断 / 重试 / 旧快照恢复另独立复核通过，保留文件
并限制实际提权。官方浏览器 153 → 156 的实际 Electron 更新 / 恢复 /
重启也通过，网站资料保留、异常资料拒绝，另三份物理抓包未批准外发
0。两项临时资源清理，旧版预安装使用源码安装器；不是全部旧环境 /
断电验收。[共享迁移](shared-mount-validation.md) ·
[浏览器升级](browser-upgrade-validation.md)。

停机旧满盘 VM 的实际界面扩容 / 文件保留 / 普通重启，以及当前包
三个精确维护进程 SIGKILL 点、重开门禁 / 界面重试 / 原始较小快照
恢复也已独立复核。前三份抓包中首份属于旧包开机；中断专项十三份
属于当前包，未批准外发均为 0，临时资源清理。不是维护首包、整机
断电或全天验收。[容量](storage-capacity-validation.md) ·
[维护中断](disk-recovery-interruption-validation.md)。

仅 `host-bridge.js` 相对 9378141 改变。更多旧环境 / 断电窗口、全天、真实 Mac
切网 / 休眠、真实住宅和第二台 Mac 尚待验收，旧包其他专项保持原
签名范围。Claude Desktop 本轮不做。现在可以试用新建环境的已验
流程；本包仍不是全部故障、线路和升级场景验收完成的正式发行版。

## 旧 9378141 包验证

以下旧包章节保留记录当时的状态，不能作为当前待办或新包验收结论。
当前试用包与安排以上方说明及暂缓清单为准。

此前包 153 项源码测试、构建和包完整性通过。出口 IP 锁定修复已通过
真实 VM 专项独立复核：检测先于业务许可、普通用户入口绕行拒绝、
出口变化及测量异常撤销终端 / 桥接 / 忙任务并停机；五份物理抓包
未批准外发 0。完整实际桌面浏览器 / 无账号 Claude Code / 文件与
固定 Git 授权 / 快照 / 加密导入也已独立复核，另六份物理抓包未批准
外发 0。十分钟持续网络零新增错误、断线阻断 / 恢复与自动隔离 /
重启另通过四份物理抓包复核，未批准外发 0。临时资源清理，核心 VM
保留。[持续网络记录](sustained-network-validation.md)。
[检测修复](egress-probe-validation.md) · [完整流程](packaged-workflow-validation.md)。

全部为本地受控服务，不是全天、真实住宅线路、真实 Mac 切网 / 休眠
或第二台 Mac 验收。旧 7395e50 的 HTTPS / SOCKS5 / DNS、连接复用 /
所属进程强退与十分钟稳定性按原包范围保留；其 IP 锁定启动检测失败，
已由当前包替代。新包其他协议、实际桌面主进程硬退出和旧环境升级
仍按改动影响补验，不把旧包全部结论转移。Claude Desktop 本轮不做。
[历史代理通道记录](proxy-transport-validation.md)。

## 旧 b3b92b6 包验证

当前包已通过 UI 扩容后完整官方浏览器 / 无账号 CLI / 文件与固定 Git
授权 / 快照 / 加密导入，四次不同正常开机、六份抓包独立复核通过。
桌面主进程强退、约 8 秒无 UI 自动关闭迟到启动、维护网络服务启动前
抓包 / 防护、关闭业务联网和重试另六份抓包复核通过。未批准外发均为
0；146 项源码测试、类型 / 构建和包完整性通过，临时资源删除。
共享 / 隧道、旧满盘与三个精确中断点结果按下方旧包原范围保留。
全天、实际 Mac 切网 / 休眠、真实线路、整机断电和第二设备仍未验收。
Claude Desktop 本轮不做。
[完整流程](packaged-workflow-validation.md) · [中断范围](disk-recovery-interruption-validation.md)。

## 旧 e1caee5 包验证

此前 e1caee5 包已通过旧满盘 VM 实际 UI 扩容恢复，以及全新环境 UI 扩容至
12 GiB 后的完整官方浏览器 / CLI / 宿主授权 / 快照 / 加密导入；
导入后容量和网站资料保留，六份抓包未批准外发 0。实际共享目录首次 /
重启 / 改只读另通过六份抓包复核。145 项源码测试、类型和包完整性
通过。同包双 VM WireGuard 浏览器 / CLI、对端断线恢复和重启四份抓包
复核通过。新增扩容三点维护进程硬退出 / 实际 UI 重试 / 较小快照恢复
十三份抓包、桌面主进程强退 / 维护网络服务启动前防护六份抓包复核通过。
迟到开机关闭的独立监测、更多中断 / 断电、休眠 / 切网、全天、真实
线路和第二设备仍未验收，Claude Desktop 本轮不做。
[中断与维护启动](disk-recovery-interruption-validation.md)。
[完整流程](packaged-workflow-validation.md) · [共享目录](shared-mount-validation.md) · [容量恢复](storage-capacity-validation.md)。

## 旧 45e0b4a 包验证

2026-10-10 18:35–18:42 UTC 实际 Electron / 全新 VM 完整透明流程通过，
18:42:22 UTC 独立复核：官方浏览器四阶段网站资料保留、无账号官方
Claude Code 工具授权 / 拒绝 / 中断恢复 / 关闭清理、文件与有限 Git
授权、UI 快照恢复与加密备份导入；三次不同开机及五份抓包未批准
外发 0，七个检查点网络监测正常，临时资源删除。
报告 `packaged-workflow-storage.json` 及对应 `-evidence.json`，SHA-256
`fdf92a8c448952252109d7bb52bf1caabd31caf134ea042241b787b552838860`。
此包另通过下面容量专项；共享 / WireGuard 结果仍按旧包保留，旧满盘
环境恢复入口、实际 Mac 休眠 / 切网、全天与真实线路尚未完成。

新增容量修复候选 `release/guest-capacity-fix-candidate/mac-arm64/MuCodeSandbox.app`
（45e0b4a）：修复普通用户写满后重启失败，并保证专用降权抓包程序能
使用管理预留。实际满盘 / 重启 / UI 快照恢复 / 释放后写入及六份抓包
独立复核通过；138 项源码测试与包完整性通过。此包完整 CLI / 浏览器 /
备份使用流程已在上方对应包复验；不是下面 cf031a2 全部专项的替代结论。
cf031a2 已发现满盘重启故障；既有满盘旧环境的恢复入口仍需开发。
[容量验证](storage-capacity-validation.md)。

此前完整使用流程测试包：`release/host-network-candidate/mac-arm64/MuCodeSandbox.app`，
版本 0.4.0，Apple Silicon Mac，约 360 MiB。
临时签名标识 `cf031a2a4bbc9d55cc8b1d97e77a935b312145d2`。
不是 Apple 正式签名或公证发行版。

本包实际 Electron / 全新 VM 完整透明流程通过：浏览器四阶段资料
保留、无账号官方 CLI 工具授权 / 拒绝 / 中断恢复、文件 / 固定 Git
授权、UI 快照与加密导入、三个不同开机记录和五份抓包独立复核。
七个检查点网络监测正常且没有误停机；另通过监测死亡 / 卡死真实
停机与手动恢复、提示布局、包完整性。源码测试 138 项通过。
报告 SHA-256 `87c78219fd2bee21440370be49e2a9bcb6d2d2a3608725fd5e6408f474a0b7ab`。
同包共享目录首次 / 重启 / 改只读、双 VM WireGuard 的浏览器 / CLI、
对端断线 / 恢复 / 重启也已独立复核通过，分别六份和四份抓包未批准
外发 0。容量、旧迁移、升级故障及实际切网 / 休眠 / 全天仍需验收。
旧 4227377 保持原样，下文旧包结果按原范围保留。
[当前串联](packaged-workflow-validation.md) · [网络监测](host-network-validation.md)。

## 当前包补充专项

同一 b3b92b6 冻结包的共享目录首次 / 重启 / 读写改只读，双 VM
WireGuard 浏览器 / CLI / 对端断线恢复 / 重启，以及三个维护中断点 /
实际 UI 重试 / 较小旧快照已分别于 20:41 / 20:43 / 20:50 UTC 独立
复核通过，六 / 四 / 十三份抓包未批准外发 0，临时资源已删除。
应用没有重新构建，核心运行虚拟机保留。

十分钟持续网络专项的代理故障、长连接阻断、恢复、networkd 续租和
自动停机通过，四份抓包未批准外发 0；主动断线前出现四次短请求错误，
单独复测又出现一次连接超时，已按稳定性失败保留证据并复核，根因
未确认。该项不是零错误、全天、实际 Mac 切网 /
休眠、真实住宅或第二设备的验收。旧满盘 / 迁移 / 升级保持原包范围。
[共享目录](shared-mount-validation.md) · [隧道](wireguard-validation.md) ·
[维护中断](disk-recovery-interruption-validation.md) · [持续记录](sustained-network-validation.md)。

## 本机试用

1. 打开应用，在“系统设置”确认运行组件已就绪；未安装时点击“安装运行组件”。
2. 创建“Linux 沙箱”，选择内存、磁盘上限、语言和时区。
3. 填写自己提供的代理线路；启用“仅代理联网”和“透明代理”，保存后启动。
4. 在“网络”里检查防护和实际出口，再打开沙箱浏览器或 Claude Code。
5. 第一轮使用“检测实验室”的本地测试，不登录真实账号或调用付费模型。

“直连”会使用本机网络出口。独立资料的本机浏览器不具有 Linux 强制
出口防护。代理不是应用赠送的住宅线路，地区设置也不会自动改变公网 IP。
本轮不包含 Claude Desktop。

虚拟磁盘容量是上限，不是立即占用同样大小的文件；系统镜像、浏览器、
快照与备份会另外占用空间。首次安装运行环境需要下载官方运行组件与
系统镜像，不需要 Chromium 源码或浏览器编译环境。

## 旧 4227377 包验证

- 实际 Electron / 全新 VM，界面创建 10 GiB / 2 GiB 内存 / 2 核沙箱，
  官方浏览器合成 Cookie / localStorage / IndexedDB 在重启、快照恢复
  和独立环境导入后保留；四张 1280×800 画面非空。
- 官方 CLI 2.1.296 / Node 24.15.0，实际原生终端执行 Write / Read /
  Bash；逐次工具批准、拒绝、中断后同进程恢复、重开历史与关闭清理。
- 实际 UI 文件 / 固定 Git 授权及路径越界拒绝，快照创建 / 恢复、密码
  加密导出 / 导入，旧授权和共享 / 端口批准不继承。
- 三个不同实时 boot ID 与五份物理接口抓包独立复核，未批准外发均为
  0。2026-10-10 16:58:19–17:04:41 UTC 完成，17:05:27 UTC 复核通过，
  临时 VM / 基础镜像 / 数据已删除。没有真实账号、付费或住宅线路。
- 另一个全新 VM 先授权目录再首次打开浏览器，实际休眠 / 仅唤醒通知
  注入后浏览器 / 终端 / 授权 / 长连接关闭、停机、手动恢复通过。修复
  配置父目录归属并验证软链接拒绝；不是实际 Mac 休眠。
- 新包容量 / 完整 DNS 编辑、错误拒绝、退出重开、桌面和窄窗口截图
  通过；对旧 2651186 包仅四个后台 / 桌面文件发生已核验的变更，其他
  42 个后台 / 桌面 / 宿主文件与全部前端文件一致。该轮不运行 VM。
- 130 项源码测试通过；构建、临时签名 / 篡改拒绝、包内依赖与本地
  测试服务通过。原核心 VM 保留。

证据：`test-results/packaged-workflow-power.json` 与对应 `-evidence.json`，
报告 SHA-256 `1bb41dab5dc0c3e37236df3d177f90a630998d5cc1160a53d7a9a2ad33a9a3d3`；
`host-power-vm.json` / `host-power-vm-evidence.json`、
`delivery-controls-power.json`、`package-integrity-host-power-fix.json`。
原始串联文件 `packaged-workflow-power-1791651499356/`。各项范围见
[串联记录](packaged-workflow-validation.md) 和 [通知记录](host-power-validation.md)。

## 旧 2651186 包记录

旧包保留原签名，不将本节证据自动视作新包专项；它没有新休眠处理，
并存在先授权再首次启动浏览器的目录归属缺陷。当前交付采用上方修复包。

- 实际新包 Electron 窗口与空白数据目录，默认启用窗口沙箱。
- 选择 20 GiB 容量，9 GiB 输入拒绝，没有启动或修改已有 VM。
- 四项 DNS 配置保存、错误路径拒绝、地区保存保留配置、退出重开持久化。
- 桌面及 390 像素宽窗口布局，三张原生截图，临时数据删除。
- 与 b0cd06d 包比对 40 个后台文件、4 个桌面文件、2 个宿主组件，全部字节一致。
- 新包依赖、本地 STUN / 模拟消息、加密备份样本、临时签名及篡改拒绝检查通过。

证据：`test-results/delivery-controls-packaged.json` 与
`test-results/package-integrity-local-test.json`。
上述配置专项没有运行 VM。随后另一个全新数据目录完成新包实际
Electron / VM 串联（2026-10-10 15:55:05–16:02:31 UTC，本地次日
00:02 完成），16:02:54 UTC 独立复核通过：界面创建 10 GiB / 2 GiB
内存 / 2 核沙箱、三次不同开机记录、官方浏览器四阶段资料持久化、
无账号 CLI 工具批准 / 拒绝与中断恢复、文件和固定 Git 授权、UI 快照
及加密导入、真实 PTY / SSH / CLI 清理。五份抓包未批准外发均为 0；
本轮临时 VM、基础镜像及应用数据全部删除，原核心 VM 磁盘保留。

串联证据：`test-results/packaged-workflow-delivery.json` 与
`packaged-workflow-delivery-evidence.json`；原始文件位于
`test-results/packaged-workflow-delivery-1791647705519/`。
上一份 b0cd06d 包及其专项证据继续按原包保留，不自动转移全部结论。
新包本轮不包含共享挂载、WireGuard、公共 DNS、真实住宅或全天测试。

## 剩余交付工作

旧 2651186 包内模块已在 512 MiB 有界 APFS 映像通过实际空间不足 / 途中写满 /
恢复记录保留与启动请求拒绝 / 释放空间后恢复的存储专项。该项使用小型
测试磁盘和停机替身，不等于真实 VM / UI 或客体磁盘写满已验证。
见 [容量验证](storage-capacity-validation.md)。

浏览器升级剩余故障、真实 VM 容量故障与更多恢复中断、
Mac 休眠唤醒 / 网络切换、全天稳定性。真实线路、第二台 Mac 与
Apple 正式签名需要相应外部条件；其他平台和 Mac 强制出口仍未完成。
新 4227377 包的共享目录 / WireGuard / 容量专项仍需对应包复验，
上述通知注入不代替实际系统休眠首包时序。
