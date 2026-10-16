# 安装包串联验收记录

## 2026-10-11 桥接强退清理修复包

冻结 `release/bridge-owner-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`9621b0a5c11eddd4486eaa16bc3b6466a0b02ec3`。22:55:07–23:02:49 UTC
真实 Electron / 全新 VM 完整流程通过，23:03:47 UTC 独立复核通过。
UI 创建 10 GiB / 2 GiB / 2 核环境并扩容至 12 GiB；官方浏览器四
阶段资料保留，1280×800 画面非空，导入画面另已目视检查。真实 CLI
原生 PTY 的工具批准 / 拒绝 / 中断恢复 / 历史重开 / 关闭清理、文件
与固定 Git 授权 / 越界拒绝、UI 快照与加密导入及独立身份通过。

| 抓包 | 物理外发 | 批准 SSH | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 237 | 229 | 0 |
| 扩容后启动 | 227 | 219 | 0 |
| 原环境任务 | 42,065 | 42,063 | 0 |
| 重启 | 228 | 220 | 0 |
| 导入后首次启动 | 208 | 200 | 0 |
| 导入环境任务 | 351 | 351 | 0 |

四次不同正常开机、networkd 重启保留当前抓包、冻结模块 / 签名 /
原始记录摘要均复核通过，物理代理连接为 0，临时资源清理。
报告 `packaged-workflow-bridge-owner.json` 和对应 `-evidence.json`，
SHA-256 `7a85fc4943dde20286080e3f6d99f4c14a863bfc40a9b1096413e40322301606`；
原始目录 `packaged-workflow-bridge-owner-1791672907578/`。
实际主进程强退另通过 [专项](desktop-crash-validation.md)。不包含共享 /
WireGuard、全天、实际 Mac 休眠 / 切网、真实住宅与第二设备，旧包
网络 / 协议结果不自动转移。

## 2026-10-11 出口检测修复包

冻结包 `release/proxy-probe-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `93781410161fcf4560c244ce5469b980ffc38976`。22:30:35–22:36:32 UTC
实际 Electron / 全新 VM 完整流程通过，22:37:18 UTC 独立复核通过。
界面创建 10 GiB / 2 GiB / 2 核环境并扩容到 12 GiB；官方浏览器四阶段
资料保留、官方 Claude Code 原生终端工具批准 / 拒绝 / 中断恢复 /
历史重开 / 关闭清理、文件与固定 Git 授权及路径越界拒绝、UI 快照与
加密导入通过。导入保持独立身份并撤销旧授权。四张 1280×800 图像
独立像素检查非空，首次与导入截图另已目视检查。

| 抓包 | 物理外发 | 批准 SSH | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 198 | 190 | 0 |
| 扩容后正常启动 | 239 | 231 | 0 |
| 原环境任务 | 42,838 | 42,836 | 0 |
| 重启 | 246 | 238 | 0 |
| 导入后首次启动 | 254 | 246 | 0 |
| 导入环境任务 | 359 | 359 | 0 |

四次不同正常开机、networkd 重启保留当前抓包、冻结签名 / 模块与
原始记录核验通过；物理代理出口为 0。临时 VM 与测试数据已删除。
报告 `packaged-workflow-probe.json` / `packaged-workflow-probe-evidence.json`，
SHA-256 `9c8494579b3d5d9da72dbee013e8f4b763e151314258d041c35c6a9f4b6bc56f`；
原始目录 `packaged-workflow-probe-1791671435251/`。
此项不含出口锁定（同包另有 [专项](egress-probe-validation.md)）、
共享挂载、WireGuard、硬退出、实际 Mac 切网 / 休眠、全天、真实住宅
或第二设备；不直接转移旧包专项。

## 2026-10-11 代理通道修复包

冻结包 `release/proxy-transport-guard-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `7395e50362e01c36299c4eacabe0cbedb636cf22`。21:47:05–21:54:41 UTC
实际 Electron / 全新 VM 完整流程通过，21:55:27 UTC 独立复核通过。
UI 创建 10 GiB / 2 GiB / 2 核环境，扩容至 12 GiB 后测试官方浏览器、
无账号官方 Claude Code 原生终端、文件与固定 Git 授权、路径越界拒绝、
快照恢复及加密导入。浏览器四阶段资料保留，四张 1280×800 画面非空。
CLI 工具批准 / 拒绝、中断恢复、历史重开和关闭清理通过。

| 抓包 | 物理外发 | 批准 SSH | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 242 | 234 | 0 |
| 扩容后正常启动 | 238 | 230 | 0 |
| 原环境任务 | 43,524 | 43,522 | 0 |
| 重启 | 252 | 244 | 0 |
| 导入后首次启动 | 253 | 245 | 0 |
| 导入环境任务 | 376 | 376 | 0 |

四次不同正常开机、networkd 重启保留当前抓包、模块 / 签名 / 原始产物
核验通过；没有物理代理出口例外。临时资源已删除。报告
`packaged-workflow-transport.json` / 同名 `-evidence.json`，SHA-256
`599c6685ff327b0f72cd028a103f6063406af4ba77f0b254f10a10ca9769bc75`；
原始目录 `packaged-workflow-transport-1791668825947/`。
本项不含共享挂载、WireGuard、真实 Mac 切网 / 休眠、整机断电、
全天、真实住宅或第二设备。网络故障专项见
[代理通道记录](proxy-transport-validation.md)，不转移旧包全部结论。

## 2026-10-11 旧后台监测修复包

当前本机试用包 `release/disk-recovery-monitor-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `b3b92b627f33d1b810011558fa4ba0c18cddd934`，版本 0.4.0，约 360 MiB。
2026-10-10 20:22:49–20:30:09 UTC 实际 Electron / 全新 VM 通过，
20:30:53 UTC 独立复核通过。UI 创建 10 GiB / 2 GiB / 2 核环境，
停机后在设置中扩至 12 GiB，再完成下面旧包同样的完整透明使用流程。

官方浏览器四阶段 Cookie / localStorage / IndexedDB 保留；四张
1280×800 图像非空。官方 CLI 2.1.296 / Node 24.15.0 在实际原生终端
完成 Write / Read / Bash、批准 / 拒绝、中断后同进程恢复、历史重开
与关闭清理。文件 / 固定 Git 授权与路径边界、UI 快照与加密导入通过；
导入保持 12 GiB 和独立身份，不继承旧授权。八个检查点网络监测正常，
四次不同正常启动，networkd 重启未覆盖当前开机记录。21 个模块 /
原生文件、包完整签名、执行脚本和原始文件摘要复核通过，临时资源清理。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 229 | 0 | 0 |
| 扩容后正常启动 | 194 | 0 | 0 |
| 原环境任务 | 37,873 | 25,385 | 0 |
| 重启 | 229 | 0 | 0 |
| 导入后首次启动 | 199 | 0 | 0 |
| 导入环境任务 | 375 | 42 | 0 |

报告 `packaged-workflow-monitor.json` / 同名 `-evidence.json`，SHA-256
`93d4508ac3e92aca9304e2dfdc10ac2254285580293164dc2db4b1c463a43d87`；
原始目录 `packaged-workflow-monitor-1791663769966/`，入口
`test:packaged-workflow-monitor` 和对应 `-evidence`。
另有同包桌面强退 / 无 UI 迟到启动自动关闭 / 维护早期防护专项，见
[中断范围](disk-recovery-interruption-validation.md)。本项不含共享 /
WireGuard、三个精确维护中断点、较小旧快照、整机断电、全天、实际
Mac 切网 / 休眠、真实住宅和第二台设备；旧包结果仍按原范围保留。

## 2026-10-11 旧扩容恢复包

包 `release/disk-recovery-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`e1caee59d8049dccf71e42c2e37bf62518d2d05a`，未重新构建。
2026-10-10 19:35:22–19:42:59 UTC 实际 Electron / 全新 VM 通过，
19:43:30 UTC 独立复核通过。UI 创建 10 GiB / 2 GiB / 2 核环境，
停机后由实际设置界面扩至 12 GiB，再执行完整使用流程。

扩容后官方浏览器四阶段 Cookie / localStorage / IndexedDB 保留，
四张 1280×800 画面采样颜色 603 / 638 / 638 / 638；官方 CLI 2.1.296 /
Node 24.15.0 在真实原生终端完成 Write / Read / Bash 逐次批准、拒绝、
中断同进程恢复、历史重开及关闭清理。文件与固定 Git 授权、路径越界
拒绝、UI 快照 / 加密导入、独立 VM 身份及旧授权拒绝通过。导入后容量
仍为 12 GiB。四次不同正常开机记录匹配实时内核，networkd 重启保持
当前开机抓包，八个检查点宿主网络监测正常。21 个模块 / 原生文件、
冻结签名与执行脚本 / 原始文件哈希复核通过，临时资源删除。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 219 | 0 | 0 |
| 扩容后正常启动 | 202 | 0 | 0 |
| 原环境任务 | 38,041 | 25,239 | 0 |
| 重启 | 218 | 0 | 0 |
| 导入后首次启动 | 224 | 0 | 0 |
| 导入环境任务 | 358 | 30 | 0 |

报告 `packaged-workflow-recovery.json` / 同名 `-evidence.json`，SHA-256
`aba4cbc9d234e908867318c540bef876f9cd8ea9774320cd120727d503132cb2`；
原始目录 `packaged-workflow-recovery-1791660922969/`。入口
`test:packaged-workflow-recovery` 与对应 `-evidence`。首次脚本仍使用
扩容前开机摘要作 networkd 对照而失败；改用当前开机摘要后通过，失败
报告 `packaged-workflow-recovery-before-boot-baseline.json` 保留。
本项不是维护首包、实际硬退出、较小旧快照恢复、共享 / 隧道、整机
断电、全天、真实住宅或第二台 Mac 的证明；专项按各自范围记录。

## 2026-10-11 旧容量修复包

包 `release/guest-capacity-fix-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`45e0b4a3475ace48909deee9155ada564fed65a3`，约 360 MiB，临时签名。
实际运行 2026-10-10 18:35–18:42 UTC，18:42:22 UTC 独立复核通过。
报告 `packaged-workflow-storage.json` 及对应 `-evidence.json`，SHA-256
`fdf92a8c448952252109d7bb52bf1caabd31caf134ea042241b787b552838860`；
原始文件与四项执行脚本存档 `packaged-workflow-storage-1791657340044/`。

实际界面创建 10 GiB / 2 GiB 内存 / 2 核的全新受保护 Linux VM，
ja-JP / Asia/Tokyo。官方浏览器四阶段 Cookie / localStorage / IndexedDB
在重启、快照恢复及加密导入后保留；四张 1280×800 PNG 独立解析非空。
官方 CLI 2.1.296 / Node 24.15.0 实际原生终端 Write / Read / Bash
逐次批准、拒绝、中断后同进程恢复、历史重开与关闭清理通过。
UI 文件 / 固定 Git 授权、路径与软链接越界拒绝、旧授权撤销、快照及
加密导入、独立 VM 身份、不继承共享 / 端口批准通过。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 200 | 0 | 0 |
| 原环境任务 | 37,349 | 25,063 | 0 |
| 重启 | 219 | 0 | 0 |
| 导入后首次启动 | 228 | 0 | 0 |
| 导入环境任务 | 385 | 50 | 0 |

三个不同实时 boot ID 与记录匹配，网络服务重启不覆盖抓包。七个
检查点网络监测 ready，无误触发隔离停机；19 个后台 / 桌面 / 原生
文件、签名和原始文件哈希复核通过。临时 VM / 基础镜像 / 数据删除。
没有实际账号、付费、住宅线路、共享挂载、WireGuard、整机断电或
全天运行；这些不能由本项结论代替。真实客体满盘 / 重启 / UI 恢复
另见 [容量记录](storage-capacity-validation.md)。

## 2026-10-11 旧网络监测包

包 `release/host-network-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`cf031a2a4bbc9d55cc8b1d97e77a935b312145d2`，约 360 MiB，临时签名。
实际运行 2026-10-10 17:43:50.235–17:49:15.072 UTC（本地 01:43–01:49），
17:49:45.585 UTC 独立复核通过。报告 `packaged-workflow-network.json`
及对应 `-evidence.json`，SHA-256
`87c78219fd2bee21440370be49e2a9bcb6d2d2a3608725fd5e6408f474a0b7ab`；
原始文件及四项执行脚本存档 `packaged-workflow-network-1791654230230/`。

实际 UI 创建 10 GiB / 2 GiB 内存 / 2 核 Linux 沙箱，ja-JP / Tokyo，
强制透明代理。官方浏览器四阶段合成 Cookie / localStorage / IndexedDB
在重启、UI 快照恢复与加密导入后保留；四张 1280×800 PNG 603 / 638 /
638 / 638 种采样颜色。官方 CLI 2.1.296 / Node 24.15.0，在实际原生
终端逐次 Write / Read / Bash 批准、拒绝、中断同进程恢复、历史重开与
关闭清理通过。文件 / 固定 Git 能力边界、软链接与路径越界拒绝、旧授权
撤销、快照与密码加密导入、独立 VM 身份和不继承共享 / 端口批准通过。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 202 | 0 | 0 |
| 原环境任务 | 34,873 | 22,365 | 0 |
| 重启 | 194 | 0 | 0 |
| 导入后首次启动 | 219 | 0 | 0 |
| 导入环境任务 | 354 | 35 | 0 |

三个不同实时 boot ID 与记录匹配，网络服务重启不覆盖启动抓包。
七个流程检查点宿主网络监测均 ready，无误触发隔离停机。复核包括
17 个后台 / 桌面 / 原生文件，原生组件以临时副本统一签名比较；
本包与源二进制的原签名均不修改。临时 VM / 基础镜像 / 数据已删除。
没有实际账号、付费模型、住宅线路、共享挂载、WireGuard 或全天运行。
监测故障专项另见 [宿主网络验证](host-network-validation.md)。

## 2026-10-11 旧休眠与配置修复包

包 `release/host-power-fix-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`4227377499a5aaeba73db3f31b821e44a5234aff`，约 360 MiB，临时签名。
实际运行 2026-10-10 16:58:19.361–17:04:41.579 UTC（本地 00:58–01:04），
17:05:27.108 UTC 独立复核通过。报告 `packaged-workflow-power.json` 和
对应 `-evidence.json`；报告 SHA-256
`1bb41dab5dc0c3e37236df3d177f90a630998d5cc1160a53d7a9a2ad33a9a3d3`。
原始文件及四项脚本存档 `packaged-workflow-power-1791651499356/`。

实际界面从空白数据创建 10 GiB / 2 GiB 内存 / 2 核 Linux 沙箱，
ja-JP / Asia/Tokyo、强制透明代理；测试页面 URL 通过 API 配置。
官方浏览器 156 的四张 1280×800 PNG 独立解析非空（603 / 638 / 638 /
638 种采样颜色），合成 Cookie / localStorage / IndexedDB 在重启、
UI 快照恢复和加密导入后保留。官方 CLI 2.1.296 / Node 24.15.0 在
实际原生终端的逐次 Write / Read / Bash 批准、拒绝、中断同进程恢复、
历史重开与关闭 PTY / SSH / 客体进程清理通过。

UI 文件及固定 Git 授权 / 撤销、连续目录读取、路径越界 / 软链接
拒绝、未批准命令拒绝通过；UI 快照 / 密码加密导出导入保存客体文件
和网站资料，独立 VM 身份，不继承宿主挂载、端口和桥接授权。三次
实际 boot ID 不同且与当轮开机记录匹配，网络服务重启不覆盖抓包。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 202 | 0 | 0 |
| 原环境任务 | 41,697 | 29,789 | 0 |
| 重启 | 194 | 0 | 0 |
| 导入后首次启动 | 234 | 0 | 0 |
| 导入环境任务 | 362 | 35 | 0 |

余下允许包为 SSH 管理回复与 DHCP；任务抓包包含官方 CLI / 浏览器
依赖安装流量。复核检查包身份、十五个编译 / 桌面文件、四项实际脚本、
原始文件 / PNG / TUI 回执和独立包过滤解析。临时 VM / 基础镜像 /
数据已清理，原核心 VM 保留；未使用真实账号、付费模型或住宅线路。
通知注入及“先授权再首次打开浏览器”的真实 VM 修复另通过，见
[通知记录](host-power-validation.md)。配置 / 错误拒绝 / 退出重开与
窄窗口布局记录 `delivery-controls-power.json`。本流程不扩大为共享
挂载、WireGuard、实际 Mac 休眠首包、断电、容量、全天或第二台 Mac。

## 2026-10-11 本机配置交付包（串联通过）

包 `release/local-test-candidate/mac-arm64/MuCodeSandbox.app`，CDHash
`26511866b6077c14947fc169a03e5496ba887a83`，约 360 MiB，临时签名。
实际运行 2026-10-10 15:55:05.525–16:02:31.625 UTC（本地次日），
独立复核 16:02:54.462 UTC 通过。报告
`test-results/packaged-workflow-delivery.json` 和同名前缀 `-evidence.json`；
报告 SHA-256 `ad20f0efe121b40173a14406172d9f1e3b90a7c0ad6c2edc489b082805b77891`。
原始记录 / 源码存档位于 `test-results/packaged-workflow-delivery-1791647705519/`。

真实新包界面创建 10 GiB 磁盘、2 GiB 内存和 2 核 Linux 沙箱，保存
ja-JP / Asia/Tokyo 与强制透明代理后再启动；测试网站 URL 通过实际
应用 API 设置，不声称在创建窗口填写 URL。官方浏览器 156.0.8078.4
有四张实际 1280×800 画面，一次合成登录后的 Cookie / localStorage /
IndexedDB 在重启、快照恢复和加密导入后保留。官方 CLI 2.1.296 /
Node 24.15.0 实际 TUI 通过拒绝、单次批准 Write / Read / Bash、中断
恢复、历史恢复和终端关闭后宿主 PTY / SSH / 客体 CLI 退出。

实际 UI 文件授权 / 撤销、连续列目录、批准的 Git 状态和未批准命令
拒绝、写权限不授予命令、符号链接 / 越界路径拒绝通过。UI 快照恢复
及加密导入保存客体文件与网站资料，导入后 VM 身份独立，不带入旧
挂载、端口或桥接授权。三次实时内核 boot ID 与对应开机记录匹配且
互不相同，网络服务重启不覆盖记录。

| 抓包 | 物理外发 | 批准代理 | 未批准 |
| --- | ---: | ---: | ---: |
| 首次启动 | 220 | 0 | 0 |
| 原环境任务 | 36,096 | 23,959 | 0 |
| 重启 | 215 | 0 | 0 |
| 导入后首次启动 | 223 | 0 | 0 |
| 导入环境任务 | 358 | 47 | 0 |

其余允许包为 SSH 管理回复和 DHCP；任务捕获包含冷安装下载。
独立复核检查实际包身份 / 窗口沙箱、包内模块、脚本存档及原始文件
摘要、PNG 像素、模拟服务回执和原始物理网卡抓包。本轮 VM、基础
镜像与临时目录已删除，原核心 VM 磁盘仍在，没有真实账号或付费调用。

此轮是透明模式，没有共享挂载；不证明新包 WireGuard、双版本升级、
全天 / 休眠 / 切网、容量 / 断电、公共 DNS、真实住宅、第二台 Mac 或
正式 Apple 权限。旧 b0cd06d 的原脚本和复核脚本已按原样存档，旧报告
保持原内容。复验入口：`test:packaged-workflow-delivery` 与
`test:packaged-workflow-delivery-evidence`，复用已校验的官方压缩包。

## 2026-10-10 启动记录修复候选（串联通过）

该轮候选为 `release/boot-capture-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `b0cd06dd921a9ba759336fb39c8cb6e40e22fde4`。完整临时签名、
资源篡改拒绝和十项包内原生文件 / 命令边界测试通过；源码 123 项自动
测试及构建通过。实际 Electron / 空白 VM 的完整流程于 14:07:11 至
14:13:54 UTC 通过，独立复核于 14:14:09 UTC 通过。

报告为 `test-results/packaged-workflow-latest.json` 与
`packaged-workflow-latest-evidence.json`，原始画面 / 终端 / 抓包位于
`test-results/packaged-workflow-1791641231901`。独立复核验证了实际应用
身份、窗口系统沙箱、十五个包内模块及对应构建文件摘要、脚本和原始文件
摘要、四张实际浏览器 PNG 像素、模拟服务回执、真实 PTY 清理和五份原始
物理网卡抓包。仅摘要一致或功能观察绿色不能代替这些检查。

| 流程 | 新包的实测结果 |
| --- | --- |
| 启动记录 | 首次 / 重启 / 导入启动的实时 boot ID 与各自记录一致且三者不同；网络服务重启不覆盖原记录 |
| 浏览器 | 官方 156.0.8078.4，四阶段实际 1280 × 800 画面；ja-JP / Asia/Tokyo / Linux；一次合成登录后，Cookie、localStorage、IndexedDB 在重启 / 恢复 / 导入后保留 |
| 宿主授权 | 实际 UI 只读 / 读写授权、连续列目录、批准 Git 状态；写权限不授予命令，未批准 Git、路径逃逸、符号链接和撤销后访问均拒绝 |
| CLI | 冷安装官方 2.1.296 / Node 24.15.0；实际终端工具单次批准 / 拒绝、中断后同进程继续、重新打开恢复历史；终端关闭后宿主 PTY / SSH 和客体 CLI 退出 |
| 快照与备份 | 实际 UI 创建 / 恢复 / 加密导出 / 导入，文件及网站数据保留，导入独立 VM 身份且无旧共享、端口或桥接授权 |
| 清理 | 本轮 VM、基础镜像和临时目录全部删除；无 UI 异常或崩溃，不操作原核心 VM |

五份抓包的物理输出分别为 200 / 38,766 / 195 / 206 / 361 包，未批准
外发均为 0。原 / 导入环境任务阶段有 24,928 / 40 个批准代理包；原环境
抓包从冷安装前开始，包含组件下载，不能把所有包数当成模型业务流量。
其他允许包为 SSH 管理回复和 DHCP。没有使用真实账号或付费模型请求。

本轮是透明代理模式，没有共享目录；不能转移旧包的 WireGuard、共享
首次挂载、双版本升级或所有事务故障结论。长时间 / 休眠 / 切网、第二台
Mac、真实住宅线路、正式签名及 Mac 系统级网络防护仍未验收。

前一轮 74fda9a 包在 13:46 UTC 完成了功能观察，但独立复核发现导入
环境的启动 pcap 与原环境完全相同，不能证明导入后的首次启动。
原报告和拒绝结果分别保留为
`test-results/packaged-workflow-74fda9a-before-boot-capture-fix.json` 与
同名前缀的 `-evidence.json`。不把功能观察成功当作完整验收成功。

新配方在每次内核启动时重新抓取有界记录，同时保存内核 boot ID。
记录完成后保持 networkd 依赖的服务为 active / exited，避免停止网络
或在重启网络服务时覆盖抓包。验收要求原环境首次启动、正常重启和导入
环境首次启动的三份记录分别匹配实时 boot ID，三者不同；另独立复核
原环境和导入环境任务流量、浏览器实际画面、CLI 交互和临时资源清理。

旧环境有 tcpdump 但缺少新 boot ID 时，先安装记录配方并安全停止，
再次启动后才能提供新记录；没有 tcpdump 的旧环境明确无法提供该证据。
这不能补证旧备份升级前第一次开机的流量，也不是修改了浏览器内核。

## 历史 5558c78 包的已通过范围

2026-10-10，09:07:28.595–09:16:10.399 UTC，完整串联验收通过。
原始报告为 `test-results/packaged-workflow.json`，`passed: true`、
`freshVmTested: true`、`reusedTestVm: false`、`testResourcesRemoved: true`。
抓包、画面、终端记录及 SHA-256 保存在
`test-results/packaged-workflow-1791623248588/`，报告同时记录验证脚本哈希。

验收对象为 `release/shared-mount-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash 为 `5558c78a8c1feee996ee31da5149d338d183fa27`。直接启动实际
Electron 包，在空白独立目录创建受保护 Linux VM；确认包内应用路径、
renderer sandbox 与签名。使用本地模拟网站及模型服务，无真实账号或
付费模型请求。Claude Desktop 按用户要求不在本轮范围。

## 实际通过的流程

| 项目 | 实际观察 |
| --- | --- |
| 首次开机 | 20,352 字节原始抓包，190 个物理外发包，仅批准代理、SSH 管理回复与 DHCP；普通用户任意 sudo 被拒绝 |
| 官方浏览器 | 1280 × 800 实际画面、像素非空；语言 ja-JP、时区 Asia/Tokyo，保持官方 Linux 平台信息；冷启动只进行一次合成登录 |
| 资料持久化 | Cookie、localStorage、IndexedDB 在重启、快照恢复、加密备份导入后保留，没有额外模拟登录 |
| 文件桥接 | 通过实际 UI 授权、撤销；只读写入、路径逃逸和符号链接逃逸被拒绝，读写授权修改实际宿主测试文件 |
| 官方 CLI | 冷安装 Claude Code 2.1.296 / Node 24.15；实际终端拒绝及批准 Write、Read、Bash，中断后同进程继续、退出后恢复历史 |
| 终端关闭 | UI 关闭终端后，本机实际 PTY 的 limactl / SSH 子进程、客体 CLI 和等待中的模拟流均退出 |
| 网络 | 任务前后防护 active、完整性 verified，防火墙及转发配置哈希不变；指定物理网卡的直接绕行失败 |
| 快照 | UI 创建、修改客体文件、UI 恢复后原内容回来；旧桥接授权失效 |
| 加密备份 | UI 导出和导入，导入后创建独立虚拟机身份；不恢复宿主挂载、端口或旧授权，客体文件及浏览器数据保留 |
| 清理 | 仅删除本轮创建的临时应用数据、VM 和基础镜像；未留下测试 VM，UI 无 pageerror 或 crash 记录 |

任务抓包原环境有 1,209 个物理外发包，其中 446 个代理包；导入环境
372 个物理外发包，其中 47 个代理包。两份抓包未批准外发均为 0；
其他允许包为 SSH 管理回复及 DHCP。此前复用停止测试 VM 的运行也通过，
但记录为 `freshVmTested: false`，不能替代这里的全新环境验收。

## 边界与复验

界面在后台原生窗口中运行，避免抢占用户焦点。终端文本通过实际 xterm
输入框的粘贴事件输入，按键通过浏览器测试接口传入，再经过真实本机
PTY；未修改系统剪贴板或输入法。未验证人工前台输入法兼容或系统文件
选择器。官方浏览器和 CLI 安装包可以访问依赖下载服务；CLI 测试开始前
代理限制到两个本地模拟目的地址，真实模型服务一直禁止访问。

此轮环境没有配置 virtiofs 项目挂载，文件桥接不能替代共享目录首次
挂载的权限验收。09:47 UTC 独立空白目录专项已通过实际 UI 首次挂载、
重启、有效提权对照 / 恢复、读写改只读及原始抓包复核，详见
[共享目录记录](shared-mount-validation.md)。当时尚未覆盖最新包 WireGuard 流程；
后续 b0cd06d 包于 14:31 UTC 通过独立双 VM 浏览器 / CLI / 对端断线恢复 /
重启专项，见 [隧道记录](wireguard-validation.md)。仍未覆盖项包括
首次真实账号设置、更多 CLI 模式、休眠 / 切网、长时间运行、断电与
整盘写满、真实住宅出口、第二台 Mac、正式签名及浏览器自动升级。

旧失败报告保留，包括 `packaged-workflow-window-closed.json`。该轮窗口
关闭原因未确认；后续通过不能反推它的原因。最终验证修正了测试定位、
生命周期状态同步、导入身份检查顺序及受输入法影响的测试输入方式，
没有修改产品终端或浏览器内核来换取通过。

复验入口为 `npm run test:packaged-workflow`。官方浏览器缓存须存在于
`/tmp/mu-chromium-156.0.8078.4-arm64.zip`；网络组件可通过
`MU_TEST_SING_BOX_CACHE` 指向已有官方压缩包，两者均校验 SHA-256。
每次运行使用独立画面和抓包目录。`MU_TEST_KEEP_FAILED_RUNTIME=1`
仅在失败时保留已停止的本轮测试 VM 供诊断；成功仍自动清理。
