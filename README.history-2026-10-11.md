# 历史快照：2026-10-11 项目总览整理前

本文件保留当时的阶段说明，不代表当前安装包或新的执行安排。
当前状态以项目总览、项目状态和统一待办为准。

---

# MuCodeSandbox

在自己的 Mac 上管理独立 Linux 虚拟机、浏览器和开发终端。当前交付为 **0.4.5 本机测试版**，支持 Apple Silicon Mac。

0.4.5 的沙箱浏览器会随显示区域和本机 Retina 密度调整真实画面像素；
普通窗口、全屏与退出全屏已有本机验证：[清晰度验证](docs/retina-display-validation.md)。

使用入口与全部方案已整理为 Markdown：[文档总目录](docs/README.md) ·
[后台使用指南](docs/user-guide.md) · [技术方案总览](docs/technical-overview.md) ·
[统一待办](docs/TODO.md)。第一次使用先看后台使用指南，无需重跑开发测试或编译应用。

本机直接双击桌面的 **MuCodeSandbox** 图标；应用已安装到
`~/Applications/MuCodeSandbox.app`。当前旧开发环境为“已停止 / 直连”，
尚需自己的线路和严格防护配置，详见 [桌面入口检查](docs/desktop-launch-check.md)。

本轮优先交付 Linux 虚拟机内的浏览器和 Claude Code。浏览器网页、开发命令和它们的子进程默认在同一台 Linux 虚拟机中运行；Mac 显示画面、接收输入并管理环境。用户单独批准的宿主文件操作和有限 Git 命令在 Mac 执行，命令另受只读和禁止联网限制。Mac 上其他程序不属于这个网络防护范围。

默认使用官方浏览器，不修改浏览器内核。无必要的内核研究与大体积构建材料已清理；当前实际进展和未完成项见 [项目状态](docs/project-status.md)。

长期测试程序已通过实际浏览器 / 无账号 CLI 的 124 秒短测和独立
抓包复核；全天任务已按用户要求于 10 月 11 日 00:46 UTC 停止并清理，
约 45 分钟的部分记录保留，未列为全天通过。真实休眠尝试认证超时，
未实际睡眠，临时资源已清理，不自动重试；
需要额外条件的其余项目先暂缓。[暂缓清单](docs/deferred-validation.md)。
[长期验收状态](docs/day-workflow-validation.md)。

同包维护开机的网络服务启动前防护、桌面 pending 强退 / 界面重试
和无 UI 迟到启动自动关闭另已独立复核，六份抓包未批准外发 0。
[维护启动范围](docs/disk-recovery-interruption-validation.md)。

当前包受控加密 DNS 的系统解析、三类故障拒绝 / 恢复和物理绕行
阻断另已独立复核，六份抓包未批准外发 0；公共 / 住宅线路另验。
[系统 DNS 范围](docs/domain-network-validation.md)。

当前包实际双 VM WireGuard 的浏览器 / CLI、对端断线阻断 / 恢复和
重启资料保留另独立复核通过，四份抓包未批准外发 0。
当前包四类故障补测也已独立复核：networkd / DHCP、DNS 损坏、许可
目录 ENOSPC 和长期对端失联，另五份抓包未批准外发 0，资源清理。
[当前隧道范围](docs/wireguard-validation.md)。

当前包共享目录实际界面首次 / 重启 / 防提权与改只读另独立复核
通过，六份抓包未批准外发 0。[共享范围](docs/shared-mount-validation.md)。

当前本机试用包 `release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app`
（9621b0a，约 360 MiB），修复应用主进程强退后宿主桥接 SSH 残留。
153 项自动测试 / 构建 / 完整性通过；实际强退时已有流、新请求、终端
与文件访问阻断，所属进程全部退出，许可到期与手动恢复通过。完整
桌面浏览器 / 无账号 CLI / 文件与固定 Git 授权 / 快照 / 加密导入另
通过对应包复核；共九份物理抓包未批准外发 0，临时资源清理。
仅 `host-bridge.js` 相对旧 9378141 改变；旧包网络专项保持原范围，
不将其全部结论自动转移。全天、真实 Mac 切网 / 休眠、真实住宅及
第二设备未验收，Claude Desktop 本轮不做。
[实际强退](docs/desktop-crash-validation.md) · [完整流程](docs/packaged-workflow-validation.md)。

同一试用包的 HTTPS / SOCKS5 与出口锁定组合另通过真实 VM 独立
复核：业务许可开放前测量、错误认证 / HTTPS 证书拒绝、出口变化 /
测量异常关闭、正确配置恢复；十八份客户端物理抓包未批准外发 0。
临时资源清理，未重建应用或浏览器。合成出口回执不是住宅公网实测。
当前新建环境已可试用；其他旧环境及相关中断、全天等验收仍待
补齐。[代理组合](docs/egress-probe-validation.md)。

当前包旧共享迁移中断 / 重试 / 旧快照恢复，以及实际 Electron 的
官方浏览器 153 → 156 更新 / 恢复 / 重启已另独立复核，网站资料和
文件保留，异常资料拒绝，另三份物理抓包未批准外发 0，资源清理。
未重建应用或浏览器，仍不扩大为所有旧环境和断电窗口完成。
[共享迁移](docs/shared-mount-validation.md) · [浏览器升级](docs/browser-upgrade-validation.md)。

当前包实际界面恢复停机的旧满盘 VM、三个维护进程精确中断点 /
重开门禁 / 界面重试，以及原始较小快照恢复另通过独立复核，文件
保留、未批准外发 0，临时资源清理。尚不包含维护首包、整机断电
和全天验收。[容量](docs/storage-capacity-validation.md) ·
[维护中断](docs/disk-recovery-interruption-validation.md)。

此前试用包 `release/proxy-probe-candidate/mac-arm64/MuCodeSandbox.app`
（9378141，约 360 MiB），修复启用出口 IP 锁定后的启动检测超时。
153 项源码测试、构建与包完整性通过。实际桌面官方浏览器 / 无账号
Claude Code / 文件与固定 Git 授权 / 快照 / 加密导入，以及出口检测
先于业务许可、入口绕行拒绝和异常停机均独立复核通过。十分钟持续
网络零新增错误，断线阻断 / 恢复与自动隔离 / 重启通过；共十五份
物理抓包未批准外发 0，临时资源清理。
全天、实际 Mac 切网 / 休眠、真实住宅和第二设备仍待验收；HTTPS /
SOCKS5 / DNS 与旧环境故障按改动影响补验，不自动转移旧包结果。
[检测修复](docs/egress-probe-validation.md) · [完整流程](docs/packaged-workflow-validation.md)。

旧 7395e50 包的连接复用 / 桌面 / 协议 / 十分钟稳定性记录保留在
[代理通道记录](docs/proxy-transport-validation.md)。该包开启出口锁定后
启动检测超时，不再作为主试用入口。

旧本机试用候选 `release/disk-recovery-monitor-candidate/mac-arm64/MuCodeSandbox.app`
（b3b92b6，约 360 MiB）已补齐未完成扩容的后台关闭：真实迟到启动在
没有 UI 轮询时约 8 秒自动停止。桌面强退 / 维护启动 / UI 重试，以及
完整官方浏览器 / 无账号 CLI / 文件授权 / 快照 / 加密导入分别通过六份
抓包独立复核，未批准外发 0。146 项测试、类型 / 构建和包完整性通过。
同包共享目录六份、双 VM 隧道四份、三个精确维护中断点与较小旧快照
十三份抓包另已独立复核，未批准外发均为 0，临时资源清理。
全天、实际 Mac 切网 / 休眠、真实线路和第二设备仍待验收。
[中断范围](docs/disk-recovery-interruption-validation.md) · [交付说明](docs/local-test-delivery.md)。

此前完整候选 `release/disk-recovery-candidate/mac-arm64/MuCodeSandbox.app`
（e1caee5）：旧满盘环境的实际 UI 扩容 / 文件保留 / 正常重启及网络
已复核；扩容后的完整浏览器 / CLI / 宿主授权 / 快照 / 加密导入也已
通过真实 Electron 与 VM 验收，六份抓包未批准外发 0。共享目录实际
UI 首次启动 / 重启 / 改只读另通过六份抓包复核。145 项源码测试与
包完整性通过；临时资源清理，核心 VM 保留。新增扩容三点维护进程
硬退出 / UI 重试 / 较小旧快照恢复十三份抓包，以及桌面主进程强退 /
维护网络启动前防护六份抓包复核通过。迟到开机关闭的独立监测、实际
休眠 / 切网、全天运行及真实线路仍待验收。[中断范围](docs/disk-recovery-interruption-validation.md)。同包双 VM WireGuard 的浏览器 / CLI、
对端断线恢复和重启另四份抓包复核通过。[当前进展](docs/project-status.md)。

此前容量修复候选 `release/guest-capacity-fix-candidate/mac-arm64/MuCodeSandbox.app`
（45e0b4a）：修复普通任务写满后重启失败及启动抓包截断的问题。真实
VM 满盘 / 重启 / UI 快照恢复 / 释放后写入与六份抓包独立复核通过。
该包完整浏览器 / CLI / 备份串联于 18:42 UTC 通过独立复核，五份抓包
未批准外发 0；临时资源已删除。共享与 WireGuard 专项仍按旧包范围
保留。旧满盘恢复入口已在上述 e1caee5 包实现并单独复验。[容量范围](docs/storage-capacity-validation.md)。

此前测试候选 `release/host-network-candidate/mac-arm64/MuCodeSandbox.app`
（cf031a2，约 360 MiB）已完成同包的完整透明流程、共享目录和双 VM
WireGuard 浏览器 / Claude Code 验收与独立复核。监测组件死亡 / 卡死后
停机与撤销访问另有实测；源码测试 138 项通过。实际 Mac 休眠 / 切网、
全天运行与更多容量 / 升级故障仍待验收。[当前进展](docs/project-status.md)。

## 启动

当前本机测试包位于 `release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app`（9621b0a，约 360 MiB）。完整桌面流程与实际主进程强退专项已独立复核通过；全天与真实网络场景仍待验证。旧包网络、协议、共享目录、WireGuard、维护中断和旧满盘恢复结果按原签名保留。见 [交付说明](docs/local-test-delivery.md)。

收到休眠或唤醒通知后撤销保护环境访问并尝试停机，唤醒后需要手动恢复；此前 4227377 包的实际 VM 通知注入通过，但不是实际 Mac 休眠时序证明。此前 cf031a2 包另完成网络监测失效停机验收；心跳失效需重开应用。见 [休眠记录](docs/host-power-validation.md) 和 [网络监测](docs/host-network-validation.md)。

旧包与专项证据按原签名和范围保留；当前包已补验停机旧满盘恢复、三个维护中断点、旧共享迁移与双版本浏览器升级。更多断电窗口与全天运行尚未验收。历史浏览器研究与各轮包的结果集中在 [验证记录](docs/verification.md)。

源码启动需要 Node.js 24.15+ 和 Xcode Command Line Tools：

```sh
npm install
npm run native:build
npm run build
npm start
```

打开终端输出的本地地址，默认 `http://127.0.0.1:4367`；端口占用时选择空闲端口。启动桌面窗口或生成应用：

```sh
npm run desktop
npm run package:mac
```

本机测试版不要求付费 Apple 开发者账号。0.4 候选使用本地临时签名，完整资源校验与篡改拒绝已实测；它没有开发者签名、公证或 Apple Network Extension 授权。当前 Linux 网络防护不依赖 Network Extension。

## 当前能力

| 能力 | 当前状态 |
| --- | --- |
| Linux 环境 | Lima / Apple VZ、Ubuntu 24.04 ARM64；创建、启动、停止、删除、真实指标 |
| 文件边界 | 仅显式映射项目，默认只读；不共享宿主 home、SSH agent 或用户 SSH 密钥 |
| 开发终端 | 交互终端以无任意 sudo 权限的 dev 用户运行；Claude Code 安装入口；有限包安装命令 `mu-install` |
| 透明网络 | sing-box TUN 接管普通 TCP 和系统 DNS；HTTP / HTTPS / SOCKS5 代理；HTTPS 证书 / 加密故障、SOCKS5 认证 / 无认证 / 错误凭据 / DNS 故障 / 断线恢复与重启实测通过；其他 UDP、QUIC、IPv6 阻断 |
| 整包隧道测试模式 | Linux 内核 WireGuard，私钥加密保管、受控加密 DNS、启动核验与到期断网；真实双 VM 的网卡抓包、旁路阻断、错误密钥、故障和恢复通过 |
| 开机防护 | 无账号、无项目共享的受信基础镜像先准备并封存；新严格环境首次启动即带默认拒绝规则，已实际抓包验证 |
| 防护监测 | 宿主定时核对内核规则、开机文件、透明配置、路由和 DNS；异常关闭终端、撤销桥接并停止 VM |
| 休眠通知处理 | 收到 suspend / resume 即关闭管理访问，异步撤销连接和授权并尝试停机；实际 VM 注入测试通过，不自动重启；真实 Mac 休眠首包和切网另验 |
| 应用故障断网 | 严格 VM 的短期内核许可；实际管理进程被杀、许可目录写满时自行撤销、已有 / 新连接阻断、重启前业务拒绝和正常退出撤销通过；休眠 / 切网另需验收 |
| 出口核验 | 可显式批准公网 IPv4；启动和受管访问核验、后台变化 / 测量失败停机已通过真实 VM 测试；定时检查仍有时间窗口 |
| Linux 浏览器 | 固定官方 Linux ARM64 Chromium、真实 Linux 平台、认证远程画面；资料隔离 / 持久化和七类上下文已验；新增生产软件 WebGL / WebGL2，真实像素、renderer / 图形进程各线程保护、启动失败拒绝和恢复通过。Worker 晚注册字体、完整媒体、WebGPU 和长期性能另验 |
| 旧本机浏览器 | 独立会话与代理、时区和语言；不等同于受 Linux 防火墙保护的浏览器 |
| 宿主文件与有限命令桥接 | 显式目录和读写授权、短期凭据、路径边界、审计和撤销；三项独立批准的只读 Git 操作，固定参数、禁止联网、超时 / 超限终止；b0cd06d 包内十项边界测试、真实 Electron / VM 授权撤销、重复列目录及活动命令下退出 143 毫秒无遗留进程，抓包独立复核通过，不提供任意宿主 shell。见 [记录](docs/host-command-validation.md) |
| VM 快照 | 停机创建、内容校验、恢复回滚与取消处理；真实 VM 恢复 / 回滚 / 配置保存 / 清理中断后重启通过；不回滚共享项目 |
| 加密备份 | 快照导出为密码加密文件；导入创建新环境并清除本机共享 / 端口授权；实际独立数据目录迁移、首次启动防护和旧管理密钥拒绝通过，尚未换第二台 Mac 验证 |
| 无账号验收 | 合成登录、DNS / STUN、跨上下文检测、模拟模型；真实 Claude Code 的 print 流式工具 / 取消 / 超时 / 断线重试及源码和实际包终端基本 TUI 的拒绝、单次授权、中断 / 对话恢复与关闭清理实测；首次账号设置另验 |

首先在系统设置安装 Lima，再创建环境。直接联网模式不提供“只能走代理”的约束。使用受保护浏览器时，应配置自己的代理，启用“仅代理联网”和“透明代理”，并确认实际防护检测通过。仅代理联网但未启用透明代理的环境不开放 Linux 浏览器。

住宅代理线路需要自行提供。代理不会改变 Mac 运营商分配的地址；它决定经代理访问的网站看到哪个网络出口。时区和语言不会自动证明出口地区一致，也不会把 Linux 浏览器变成 Mac 浏览器。

生产浏览器已从二维模式升级为经过实际验证的软件 WebGL / WebGL2；使用 CPU 绘图，可能慢于硬件显卡，如实呈现 Linux / Mesa 特征。保护检查发生在网站导航前；新增严格环境每 8 秒及受管访问时的运行中检查，发现异常会撤销画面、终端和桥接并停止 VM。源码和新包实测约 10 至 11 秒完成故障停机；这是采样而非瞬时保证，不是所有浏览器进程都采用相同隔离机制。完整媒体与 Worker 字体差异仍单独跟踪，见 [运行中防护](docs/browser-monitor-validation.md)、[图形防护与故障验收](docs/browser-gpu-validation.md) 和 [媒体验收](docs/browser-media-validation.md)。

WireGuard 整包隧道已接入配置、受保护基础镜像、正常启停、DNS、完整性检测和到期许可，并通过真实双 VM 验收。界面入口为「WireGuard · 测试」。需要自行提供支持 WireGuard 的对端及密钥，普通住宅 HTTP / SOCKS 账号不能直接用于此模式。当前仅支持单对端、IPv4 /32、全量路由；其他 UDP、明文外部 DNS 和 IPv6 阻断。新模式的首次开机、浏览器冷安装 / 操作 / 持久化、真实 Claude Code 工具与中断，以及实际安装包运行均通过无账号测试；新增网络服务重启 / 续租、DNS 损坏、许可目录写满与持续对端断线的阻断 / 恢复实测。实际应用包的基本 TUI 授权 / 中断 / 历史恢复 / 关闭清理也已在全新双 VM 通过。其他 CLI 工具与模式、真实公网 / 住宅对端、休眠 / 切网与长期故障仍待验收。HTTP / HTTPS / SOCKS5 模式仍是连接代理。见 [整包隧道验证](docs/wireguard-validation.md)。

特殊 Worker 字体和 GPU 故障的历史失败记录保留在 [验证记录](docs/verification.md)，不作为恢复浏览器内核改造的依据。

严格透明模式可启用“出口变化时停机”，手动填写批准的公网 IPv4。不会自动接受新 IP。宿主核验后续期客体内核许可；应用崩溃后的自动到期已实测，硬退出仍有最多一个许可周期的窗口，休眠与每个业务连接的最终来源另需验证。见 [出口核验验收](docs/egress-validation.md) 和 [自动断网验收](docs/guest-lease-validation.md)。

旧环境迁移时按原配置启动，执行“准备防护并停止”，成功后再保存严格配置并启动。新严格环境使用封存的基础镜像。基础镜像及运行组件的首次下载、可信引导和宿主解析代理域名使用 Mac 网络；这些操作不携带 Claude 账号或项目资料。

普通开发程序不能修改防火墙、路由或管理 SSH 密钥。`mu-install` 只允许固定包白名单。取得客体 root 的程序仍可修改客体规则；宿主监测会检测并停机，但这不是客体 root 无法突破的宿主网络边界。

## 本地数据

默认 `~/.mucodesandbox`，包含 SQLite、VM 磁盘、校验组件、配置、审计和快照。Linux 浏览器资料在各自 VM 磁盘中；旧本机 Electron 会话另存于其用户数据目录。桥接授权为短期状态，不作为可恢复的长期凭据保存。

```sh
MU_DATA_DIR=/absolute/path npm start
MU_PORT=4368 npm start
MU_LIMA_PATH=/absolute/path/to/limactl npm start
```

同一数据目录只能运行一个服务。删除环境不会删除共享的宿主项目；读写共享和读写桥接允许修改明确授权的文件。桥接授权到期、撤销或环境停止后失效。快照不包含共享项目、旧本机浏览器资料或宿主文件。

快照恢复中途退出后，下次通过正常启动入口检查并恢复磁盘和配置；回滚副本损坏会保留恢复记录并拒绝启动。历史进程强制结束及有界容量专项按各轮范围保留，不等同于真实整机断电。当前包的 UI 快照恢复、加密导出 / 导入及浏览器资料恢复已经串联验证；更多事务故障另验，详见 [快照恢复验证](docs/snapshot-recovery-validation.md)。

在快照列表选择导出，设置至少 12 个字符的密码，生成 `.mu-backup` 文件；首页“导入备份”可创建新环境。备份包含 Linux 磁盘、浏览器资料和网络凭据，密码丢失不能恢复。导入不继承宿主共享目录、端口映射或桥接授权，首次启动更换管理访问密钥与虚拟机硬件身份；客体系统和应用资料保留。已验证同一 Mac 的独立数据目录迁移，真实 Chromium 的合成 Cookie / localStorage / IndexedDB 在导入和重启后恢复，无需重新登录；另验真实解密暂存后进程硬退出、正常服务清理和重试。实际第二台 Mac、真实服务账户、整盘写满和整机断电仍待验收；见 [加密备份验证](docs/portable-backup-validation.md)。

## 验证

```sh
npm test
npm run test:lab
npm run test:native-lab
npm run test:security
npm run test:transparent
npm run test:encrypted-upstream
npm run test:socks-upstream
npm run test:socks-captures
npm run test:egress
npm run test:egress-ui
npm run test:lease
npm run test:claude-client
npm run test:claude-tui
npm run test:claude-tui-evidence
npm run test:claude-tui-packaged
npm run test:claude-tui-packaged-evidence
npm run test:claude-tui-wireguard
npm run test:claude-tui-wireguard-evidence
npm run test:wireguard-faults
npm run test:wireguard-workloads
npm run test:wireguard-packaged
npm run test:guest-browser
npm run test:browser-profiles
npm run test:browser-contexts
npm run test:browser-media
npm run test:browser-sandbox-guard
node scripts/verify-browser-gpu.ts --guard-only --packaged
node scripts/verify-browser-sandbox-evidence.ts
npm run test:hostname
npm run test:package
npm run test:bridge
MU_TEST_SING_BOX_CACHE=/absolute/path/to/verified-sing-box.tar.gz npm run test:host-commands
npm run test:host-commands-evidence
MU_TEST_SING_BOX_CACHE=/absolute/path/to/verified-sing-box.tar.gz npm run test:host-commands-packaged
npm run test:host-commands-packaged-evidence
npm run test:snapshots
npm run test:backups
npm run test:backups-browser
npm run test:backups-packaged
npm run test:backups-ui
```

实际 VM 测试使用临时环境和本地认证代理，部分步骤下载官方组件；需要 Lima。宿主桥接测试先运行 `npm run native:build`。复核脚本检查当轮源码和产物指纹，修改后需要重跑对应验收，不能沿用历史绿色。浏览器资料、[跨上下文一致性](docs/browser-context-validation.md)与加密上游有独立实际 VM 报告；通过范围与保留的失败见验证记录，报告和截图位于 `test-results/`。

第一轮不登录 Claude，不发起付费模型请求。已安装和能启动 CLI 不代表 Claude 在线账户流程已验收。桌面脚本默认不安装或检查 Claude；只有显式设置 `MU_TEST_CLAUDE=1` 才进行该安装检测，仍不自动登录。

真实 CLI 的无账号验收见 [专项记录](docs/claude-client-validation.md) 和当前包的 [串联记录](docs/packaged-workflow-validation.md)。仍未覆盖首次真实账号设置和全部断线 / 工具场景，不代替付费账户验收。旧环境须停止后重新启动，应用才会迁移端口策略，见 [端口验收](docs/port-forward-validation.md)。参考产品的相似点与浏览器位置差异见 [证据对照](docs/competitor-comparison.md)。

真实 Mac 休眠 / 切网、长期运行、更多容量 / 恢复故障和跨设备验证仍待完成。本机 Network Extension、macOS 虚拟机、正式签名公证及跨平台属于后续路线；Claude Desktop 按用户要求本轮不做。逐项差距见 [差距与验收](docs/gaps-and-validation.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目不承诺防封号，也不声称与参考产品全部功能等同。
