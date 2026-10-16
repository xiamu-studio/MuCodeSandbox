# 整包隧道验证

日期：2026-10-10。`npm run test:wireguard` 的 `test-results/wireguard-kernel.json` 于 2026-10-09 17:57:45 至 18:04:04 UTC 通过。未使用 Claude 账号，付费模型调用为零。

## 当前包四类故障补验

2026-10-11 00:51 UTC 独立复核通过。对象为 9621b0a 当前包内 45 个
冻结模块，在 Node 下驱动两台真实临时 VM：网络服务重启 / DHCP 续租、
错误 DNS 自动隔离 / 重启恢复、许可目录实际 ENOSPC（宿主计时暂停
时内核关闭已有及新业务连接）、对端长期断线 / 自动停止 / 恢复均通过。
长期断线新请求约 4.25 秒失败，自动停止约 179.6 秒；恢复后正向请求成功。

首开及四项原始物理抓包独立解码分别为 195 / 21 / 7 / 16 / 242 包，
未批准外发均为 0。故障专项排除批准的管理 SSH，避免抓包自身反馈，
每段仍有实际批准 UDP 正向对照。未声称覆盖每次重启、实际桌面 UI、
浏览器 / Claude 任务、真实 Mac 休眠、住宅线路或全天运行。

报告 `test-results/wireguard-faults-bridge-owner.json` 与对应 `-evidence.json`，
报告 SHA256 `6d8386410e3e0025d80159f17f4b9e4106fb9dec1b24ba38a4b67489e48780b8`。
入口 `test:wireguard-faults-current` 和 `test:wireguard-faults-current-evidence`。
复用了经校验的停止基础镜像，未重建浏览器或应用，两台测试 VM 和
临时数据已清理。此前软件源不可用和测试工具准备错误的失败轮保留
在各自带时间戳的原始目录，不改写为通过。

## 当前 9621b0a 安装包复验

2026-10-11 00:17:50–00:22:11 UTC 当前包实际 Electron / 全新双 VM
验收完成，00:23:27 UTC 独立复核通过。客户端 2 GiB / 对端 1 GiB，
复用缓存官方浏览器 / 网络归档，没有浏览器源码或新应用构建。
官方浏览器真实页面和 Claude Code 2.1.296 / Node 24.15.0 的实际
工具批准 / 拒绝、Escape 后同进程恢复、历史重开、关闭终端后客体
CLI / 本机 PTY 清理均通过，无真实账号 / 付费调用。

真实浏览器请求在对端断线时失败，接收端无对应请求；普通请求和
物理网卡绕行也失败。恢复后浏览器成功，重开 / VM 重启后 Cookie、
localStorage、IndexedDB、语言 / 时区保留，三张实际画面正常。
五个宿主网络监测检查点正常，两次不同实时正常开机 ID。
四份物理抓包外发 193 / 53,594 / 182 / 338，批准隧道 UDP
0 / 41,207 / 0 / 20，其他仅批准 SSH / DHCP，未批准外发均为 0。
桌面主程序和全部 45 个后台模块、源文件快照、回执、PNG 和原始
抓包独立核验，前后输入未改变。临时双 VM / 数据 / 基础镜像清理。

报告 `claude-tui-wireguard-bridge-owner.json` 与对应 `-evidence.json`；
SHA-256 `83d1b8305e9b177f2aa4e23dbbe0885592ad695824df92470c2dc6d2970e6ab8`。
原始目录 `claude-tui-wireguard-bridge-owner-1791677870344/`；入口
`test:claude-tui-wireguard-current` 与对应 `-evidence`。
不是全部 WireGuard 故障、全天、实际 Mac 切网 / 休眠、真实公网 /
住宅对端、第二台 Mac 或首次真实账号登录验收。

## 旧 b3b92b6 安装包复验

冻结包 `release/disk-recovery-monitor-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `b3b92b627f33d1b810011558fa4ba0c18cddd934`，于
2026-10-10 20:38:12–20:42:01 UTC 完成实际 Electron / 全新双 VM 验证，
20:43:09 UTC 独立复核通过。客户端 2 GiB / 对端 1 GiB，复用已校验
官方归档；浏览器合成资料、官方 CLI 2.1.296 / Node 24.15.0 的实际
工具批准 / 拒绝、Escape 后同进程恢复、历史重开和终端关闭清理通过。
真实生产网页在对端断线时失败，接收端无回执；恢复后成功，VM 重启
后网站资料保留。五个宿主网络检查点正常，两次不同正常启动记录。

四份原始抓包复核：物理外发 215 / 52,591 / 175 / 320，批准隧道
2 / 40,680 / 0 / 20，未批准外发均为 0。三阶段浏览器 PNG、原生
终端记录、完整包签名及当前全部后台模块摘要复核通过。临时双 VM、
基础镜像和数据已删除；没有重新构建应用或浏览器。

报告 `claude-tui-wireguard-monitor.json` / 对应 `-evidence.json`，SHA-256
`9a908d5dbdfcb7270c89dbdd100ed0d9f478663232348c68a9bac8cc6f38c73a`；
原始目录 `claude-tui-wireguard-monitor-1791664692868/`。入口
`test:claude-tui-wireguard-monitor` 与对应 `-evidence`。旧脚本另归档
为 `test-results/e1caee5-verify-claude-tui-*.ts`，旧报告保持原范围。
本项不含全天、实际 Mac 切网 / 休眠、全部隧道故障、真实住宅或第二
设备，也没有验证 WireGuard 扩容维护首包；此轮没有模型账号或付费。

## 旧 e1caee5 安装包复验

当前 `release/disk-recovery-candidate/mac-arm64/MuCodeSandbox.app`，
CDHash `e1caee59d8049dccf71e42c2e37bf62518d2d05a`，于
2026-10-10 19:48:22–19:53:03 UTC 实际 Electron / 全新双 VM 通过，
19:53:20 UTC 独立复核通过。客户端 2 GiB / 对端 1 GiB，官方浏览器
和 CLI 2.1.296 / Node 24.15.0 冷安装；浏览器合成资料、CLI 逐次批准 /
拒绝 / Escape 恢复 / 历史重开 / 关闭清理、对端断线时真实网页请求
失败且接收端无回执、恢复和重启资料保留通过。五个网络监测检查点
正常，两次不同正常开机记录与四份原始抓包复核通过：物理外发
197 / 49,922 / 211 / 328，批准隧道 0 / 35,928 / 2 / 19，未批准均 0。
三张浏览器画面和真实终端截图核验，临时双 VM / 基础镜像 / 数据删除。

报告 `claude-tui-wireguard-recovery.json` / 同名 `-evidence.json`，SHA-256
`9d1165ab4c16c49ef3f34aaf9c0e4170cb73bd01e65f393982142d9fe46fd80f`；
原始目录 `claude-tui-wireguard-recovery-1791661702647/`。入口
`test:claude-tui-wireguard-recovery` 与对应 `-evidence`。
失败轮 `claude-tui-wireguard-recovery-before-capture-reader.json` 保留：
tcpdump 诊断文字与 SSH 包文本交错造成误判，原始协议过滤未发现
异常包。读取器改为分离 stdout / stderr，协议过滤统计并测试错误
端口正向对照后，对同一未改动包重跑通过，没有修改防护规则或豁免。

本项仍不含扩容维护的 WireGuard 首包、实际 Mac 切网 / 休眠、全天、
真实住宅、公网来源、全部隧道故障或第二设备；这些不能从本地对端
断线恢复推断。当前包的完整透明与共享目录结果另列。

## 旧 b0cd06d 安装包扩展验收（通过）

新增入口 `npm run test:claude-tui-wireguard-latest`，对象固定为
`release/boot-capture-candidate/mac-arm64/MuCodeSandbox.app` / b0cd06d。
该入口使用全新独立客户端和本地内核隧道对端，复用校验后的浏览器及
网络组件归档，不操作原核心 VM 或真实账户。资源预算为两台各 2 GiB VM、
每台 10 GiB 稀疏磁盘；起始磁盘余量要求 100 GiB，运行要求 80 GiB。

相较历史基本 TUI 入口，新增实际官方浏览器的画面 / 合成登录与资料
持久化、对端断线时真实页面 fetch 的正反对照、恢复、客户端重启与新
boot ID，以及冷安装前开始的物理抓包。模型请求只访问本地模拟服务，
安装结束后双向禁止对端转发公网，不能据此证明住宅线路或真实公网来源。

实际运行 14:26:38 至 14:31:00 UTC 通过；14:31:32 UTC 独立复核通过。
报告为 `test-results/claude-tui-wireguard-latest.json` 与对应 `-evidence.json`，
原始记录在 `test-results/claude-tui-wireguard-latest-1791642398353/`。
独立复核入口为 `npm run test:claude-tui-wireguard-latest-evidence`，不启动 VM。
历史报告目录不覆盖，新验收脚本类型检查通过，未重新构建浏览器或应用包。

| 项目 | 实际结果 |
| --- | --- |
| 实际应用身份 | 冻结 b0cd06d 包由 Electron 启动，包路径 / 完整签名与系统窗口沙箱核实；包内所有后台模块摘要与当前构建文件一致 |
| 浏览器 | 官方 156.0.8078.4，初次 / 对端恢复 / VM 重启三个 1280 × 800 PNG 像素独立复核；ja-JP / Asia/Tokyo / Linux；一次合成登录，Cookie / localStorage / IndexedDB 持久化 |
| CLI | 冷安装官方 2.1.296 / Node 24.15.0，记录实际可执行文件摘要；真实 Write / Read / Bash 单次批准 / 拒绝、Escape 后同 PID 继续、重新打开后新 PID 恢复 5 → 6 轮、关闭终端清理宿主 PTY 与客体进程 |
| 对端断线 | 生产浏览器页面 fetch 先取得成功回应；对端接口关闭后 1.5 秒请求超时，接收端没有收到该探测；普通请求 / 浏览器来源请求 / 指定 eth0 绕行均失败；恢复对端后同网页回应成功 |
| 重新开机 | 新抓包 boot ID 匹配实时内核且与首次不同，重启后防护 active，网站资料保留 |
| 接收与公网边界 | 安装后对端双向阻断客户端公网转发，69 个拒绝包正向计数；本地服务观察到 10 个连接来源均为隧道 10.77.0.2 |
| 清理 | 两台临时 VM、基础镜像和两个数据目录均删除；原核心 VM 保留，无 UI 或清理错误 |

四份 SLL2 原始抓包独立按实际客体 eth0 索引 2 与协议过滤：首次开机
202、冷安装 / 任务 / 对端断线恢复 53,478、重启开机 235、重启浏览器
350 个物理 IP 输出包；未批准均 0。批准隧道 UDP 分别为 0 / 40,549 /
2 / 21；第一次开机有真实 SSH / DHCP 正向对照。任务抓包包含依赖下载，
不能把全部包数当成模型业务请求。旁路没有回退到直接 HTTP / DNS / IPv6。

该项没有做全时长压力、Mac 休眠 / Wi-Fi 切换、所有 UDP 应用、全部 CLI
工具 / 模式、错误密钥 / 路由破坏 / 许可到期的新包专项、共享挂载、快照
事务故障或第二台 Mac。对端接口关闭只模拟这一类线路故障；不是所有网络
故障或瞬时检测承诺。网络状态可能保留新鲜握手，实测请求仍失败；后台
过期握手隔离另按原有策略。没有使用 Claude 登录或付费模型。

## 历史内核原型

一次性受保护 Ubuntu ARM64 VM 中创建三套隔离网络空间，分别运行客户端、WireGuard 路由器和 HTTP 接收端。内核为 6.8.0-134-generic，WireGuard 工具为 1.0.20210914。安装依赖经过现有批准代理；被比较的业务连接只在隔离网络空间中经过内核 WireGuard，不经过 HTTP / SOCKS 连接代理。

- 合成接收端先有可用的直接路由正向对照，随后启用隧道与默认拒绝规则，实际握手和 HTTP 请求成功。
- 对照客户端加密前与接收端解密 / NAT 后的真实 TCP SYN。除 NAT 必须更新的 TCP 校验值外，整个 TCP 内容逐字节一致，包括序列号、窗口、标志与选项；源地址从 10.77.0.2 变为 192.0.2.129，TTL 从 64 变为 63。
- 直接指定底层接口并增加可用直连路由仍被拒绝；错误对端密钥不回退，恢复正确密钥后可用；关闭隧道后普通请求与额外直连路由均失败。
- 客户端底层接口捕获 13 个出站包，只允许指定 WireGuard 对端 UDP 端口，没有明文 HTTP。此接口是隔离 veth，不是 VM 的 eth0 或公网线路。
- 私钥配置文件实际为 root 属主 / 0600；没有将私钥放入命令参数或报告。三个网络空间均被删除，原有 VM 防护在测试前后通过核验；一次性 VM 和数据目录清理完成。

保留抓包：`test-results/wireguard/client.pcap`（461 字节）、`receiver.pcap`（531 字节）、`transport.pcap`（2242 字节）。私有目录 0700，文件 0600。

## 配置与生命周期集成

2026-10-09 18:37:14 至 18:42:09 UTC，`npm run test:wireguard-runtime` 的 `test-results/wireguard-runtime.json` 通过。测试使用两台独立 VM，客户端经实际 eth0 和 Mac 上仅回环绑定的合成 UDP 转发到另一 VM 的内核 WireGuard。对端 VM 没有账号或共享项目，HTTP 接收服务为合成数据；DNS / HTTPS 正向对照使用公开服务，不调用付费模型。

- 通过应用正常创建和启动受保护客户端，宿主核验内核公钥、唯一对端、端点、地址、MTU、标记、路由、握手、DNS、开机依赖和文件权限后，才激活业务许可。
- 实际 HTTP、系统 DNS 和校验证书的 HTTPS 成功；业务进程没有 HTTP / SOCKS 代理环境变量。sing-box 在此模式只处理本地 DNS，TCP 业务由内核路由，不经过其用户态 TCP 代理。
- 实际 eth0 出站抓包只有批准对端 UDP、管理 SSH 和必要 DHCP；直接宿主 TCP、绑定物理网卡的外部 DNS / UDP，以及有可用路由的 IPv6 均被拒绝。抓包保存在 `test-results/wireguard-runtime/physical.pcap`，不是历史 veth 原型抓包。
- 删除隧道路由后，完整性检测失败，业务连接失败而没有直连回退；恢复批准规则后正常。停止隧道后检测失败、隔离停机，正常重启可恢复。
- 错误对端公钥启动失败并实际停机；失败清理先封闭网络、移除隧道，再停止 VM，配置能够修正并重新启动。
- 关闭宿主定时续期后等待 47 秒，内核 45 秒许可实际过期，新的业务请求失败，旧会话不能重新续回；这项不是仅检测宿主计时器。
- 切回直连后 DNS / HTTPS 恢复，隧道接口和客体私钥文件删除。私钥在客体为 root:root / 0600，dev 无法读取，应用日志未出现私钥。主机数据库用 AES-GCM 加密私钥，公开 API 仅返回是否已配置；加密不等同 VM 整盘加密。
- 两台一次性 VM、基础镜像和测试数据目录已清理。此测试未验收真实住宅 / 公网 WireGuard 对端，也未在此网络模式下运行完整浏览器或 Claude 工具任务。

`npm run test:wireguard-ui` 的 `wireguard-ui.json` 于 18:38:19 至 18:38:20 UTC 通过。实际本地 API 验证模式切换、锁定防火墙前提、必须填写的密钥、密码式输入、API 不返回私钥、留空保持已有密钥、其他设置保留配置、切回直连删除配置，以及 Mac 模式拒绝。1440、390、320 像素布局截图已人工查看，未见重叠。它不是 VM 网络测试；运行报告中的静态 `uiModeExposed: false` 仅表示该运行脚本没有测试界面，以独立 UI 报告为准。

对端不可达时，业务流量立即无法通过隧道；后台会在握手超过 180 秒或其他完整性检查失败时隔离。握手新鲜不能证明每一个目标网站可达，也不是立即发现所有线路故障的承诺。应用硬退出后，业务许可最多到上次续期的 45 秒截止；握手与受限管理流量可以继续。

上述历史候选包 `4a52bba2ddc343153ad2a725f49216720aa7f407` 的原透明代理回归另有报告。当前候选与新模式任务实测见下节，不把历史包与当前包混为同一结果。

## 浏览器、真实 CLI 与实际安装包

上一轮 2026-10-09 19:11:48 至 19:19:14 UTC，`npm run test:wireguard-packaged` 通过；报告与目录已另存 `wireguard-workloads-before-lease-storage-fix`。两台全新一次性 VM，先经正常源码生命周期安装真实客户端和浏览器，再停止源码服务，使用同一已准备的磁盘启动真正的 Mac 安装包。全程无 Claude 登录或付费请求。

- 新严格客户端首次开机抓包 19,544 字节，183 个物理 IP 输出包，仅管理 SSH / DHCP。此段捕获在应用完成网络配置前停止，当时没有 WireGuard 业务传输；不声称首次开机文件覆盖之后的整个安装阶段。后续冷安装和任务由另一份独立抓包覆盖。
- 实际 Linux Chromium 156.0.8078.4 冷安装、1280 x 800 画面、鼠标与地址栏键盘操作、390 像素查看器、页面 / Worker / 请求头 ja-JP 与 Asia/Tokyo、HttpOnly Cookie 和 localStorage 重开持久化通过。两次关闭均为 Normal。renderer 实际保持非 root、Seccomp 2、NoNewPrivs 1 和独立 PID namespace，没有关闭 sandbox 参数。
- Claude Code 2.1.295 / Node 24.15.0 以 dev 运行，实际 Write / Read / Bash 与分段工具参数成功；原生 PTY 内 Ctrl-C 后服务连接关闭、CLI 退出、shell 可继续使用。测试是 `claude -p` 在交互终端里运行，**不是完整 Claude TUI 验收**。
- 截断流后实际观察流式和非流式重试均断开，未创建不完整工具标记文件；观察后由测试主动取消重试，再运行新文本任务成功。不能写成客户端自行最终失败。
- 安装完成后，测试出口 VM 以 nft 同时阻断客户端的双向外部转发，只保留固定本地网页 / Messages 接收端；外网 curl 实际失败，计数器记录 83 个拒绝包。接收端观察源为隧道内 10.77.0.2。它是固定目标的本地测试转接，不是公网出口来源证明。
- 随后同轮复跑物理 TCP / DNS / UDP / 有路由 IPv6 旁路拒绝、删除路由、停隧道与隔离重启、错误密钥修正、47 秒后内核许可过期，以及切回直接网络 / 删除隧道私钥，均通过。
- 实际 0.4.0 安装包 CDHash `e0db1f5bf97702f7856cd23fa238cd5f00f9832e`，19:18:51 至 19:19:14 UTC：正常启动隧道、真正的 Electron 浏览器窗口、键鼠与语言 / 时区、持久资料、受限 dev 原生终端、实际 Write / Read / Bash 和 Ctrl-C 通过，关闭资料 Normal，防护摘要保持相同。任务阶段外部转发保持阻断。包内完整 TUI、截断流 / 超时 / 全部工具故障仍分别验收。
- 四份完整可读抓包以 tcpdump 协议过滤独立复核，`capture-audit.json` 通过：开机 183、冷安装 / 源码任务 59,449、旁路测试 79、实际包任务 956 个物理 IP 输出包，未批准包均为 0。后三组均有实际批准端点 UDP 和管理 TCP 正向对照；开机组有 SSH / DHCP 正向对照。记录文件 SHA256，客体实际 eth0 ifindex 为 2；不能用 Mac 显示的接口名称替代客体索引。
- 私有目录 / 抓包为 0700 / 0600，传输字节数与客体实际文件大小一致、文件头有效；两台 VM 和临时数据均清理。该轮 70 项自动测试与构建通过。

入口：`npm run test:wireguard-workloads` 只运行源码流程；`npm run test:wireguard-packaged` 增加实际 `.app`。结果目录为 `test-results/wireguard-workloads/`，包括 `workloads.json`、`packaged-workloads.json`、四份 pcap、实际桌面 / 窄屏截图与 CLI 输出。可使用实际客体索引复核：`node scripts/verify-wireguard-captures.ts --interface-index=2`。本轮索引已经通过客体 `/sys/class/net/eth0/ifindex` 实际读取。

## 当前候选回归

浏览器原生语言 / 新窗口修复后，2026-10-09 20:23:08 至 20:30:49 UTC 从全新两 VM 重跑 `npm run test:wireguard-packaged`，最新 `test-results/wireguard-workloads.json` 通过。实际冷安装 CLI 为 2.1.296；浏览器输入 / 资料 / sandbox、真实三个工具、PTY Ctrl-C、两类截断后取消重试与新任务恢复均通过，通用旁路 / 路由 / 隧道 / 错误密钥 / 许可到期 / 直接模式恢复全部复跑。宿主复用已下载的浏览器归档，客体仍为全新磁盘、首次依赖安装及 SHA256 校验，不声称本轮重新下载浏览器归档。

真正候选包 CDHash `5f305193359bcbe113e07dc86d944236da327101` 的实际窗口阶段为 20:30:08 至 20:30:49 UTC，浏览器与原生 PTY 中 CLI 2.1.296 工具和中断通过。源码与包内都实际鼠标打开新窗口，至少两个页面目标，新页面及其 Worker 与原页面身份一致；界面原生日期语言 ja 的配置检查通过。仍复用同轮源码冷安装后的磁盘，不是全新 Mac 或包内冷下载证明。桌面与 390 像素截图实际查看，画面非空、控件未重叠。源 / 包阶段外部转发均阻断，实际计数为 71 / 7 包。

四份完整抓包独立复核于 20:31:02 UTC 起通过，物理 IP 输出包为 186 / 58,147 / 82 / 1,083，未批准包均为 0；实际客体 eth0 ifindex 在运行时读取为 2。首次开机段尚无批准 UDP，但有实际 DHCP 和管理流量正向对照，另外三份均有隧道 UDP。`package-integrity.json` 同包 5906 个资源 deep / strict、篡改拒绝、STUN 与 Messages 两类截断通过。最新 72 项自动测试和构建通过。透明代理回归 `transparent-network.json` 于 19:34:44 UTC 开始并通过。

上一轮 1072736 包的 19:38:20 至 19:47:03 UTC 回归与独立抓包复核保留在 `wireguard-workloads-before-native-identity-acceptance.json` 和同名目录；应用保存在 `release/candidate-before-native-browser-identity-fix/`。更早 e0db1f5 包及报告同样保留，不把历史结果写成当前包的新窗口证明。更广七类浏览器上下文、字体与 ServiceWorker 缓存独立验收见 [浏览器专项](browser-context-validation.md)。

## 实际包基本交互终端

2026-10-09 23:51:02 至 23:54:05 UTC，新增 `npm run test:claude-tui-wireguard`
通过。实际 `release/tui-candidate` 的 7d6e3ea 包通过自身 API 新建严格客户端、
冷安装真实 CLI 2.1.296 / Node 24.15.0，另一台独立 VM 运行内核 WireGuard
对端。未复用旧测试磁盘，也未由源码运行器代替应用启动 CLI。

依赖安装后以对端 nft 规则双向阻断客户端公网转发，实际外网 HTTPS 失败，
固定本地服务可达，接收源均为隧道内 10.77.0.2，拒绝计数器记录 15 包。
实际 Electron 原生终端的拒绝 Write、单次批准 Write / 写文件 Bash、真实
三个工具、Escape 后同 PID 继续、退出后新 PID 恢复 5→6 轮，以及关闭
终端后宿主 limactl / ssh TTY、客体 CLI 和响应均退出，通过。主窗口保留，
防护检查有效、摘要相同，物理接口直连失败。

两份原始抓包：首次开机 23048 字节、216 个物理 IP 输出、批准对端 UDP
2 包；交互阶段 150235 字节、981 个物理 IP 输出、批准 UDP 454 包。
未批准输出均 0。实际 eth0 ifindex 为 2，开机有 DHCP 正向对照；23:55:37
UTC 独立代码 / 包签名 / 截图 / 回执 / 对端规则和 pcap 复核通过。两台
自有 VM 与临时目录已删除，构建通过。

报告为 `claude-tui-wireguard.json` 与对应 `-evidence.json`，产物目录同名。
复核入口 `npm run test:claude-tui-wireguard-evidence` 不启动 VM。使用官方
演示模式和本地模拟 Messages，没有账号或付费调用；首次账号设置、其他
工具 / 子进程 / 模式、包内全部故障、真实住宅线路和长期运行仍未验收。
旧浏览器 / 快照证据保留旧包范围，不能转移到此新包。

## 网络与许可存储故障

2026-10-09 19:38:51 至 19:43:27 UTC，`npm run test:wireguard-faults` 中独立的 `test-results/wireguard-faults/faults.json` 四项场景通过。完整入口于 19:37:05 至 19:46:26 UTC 通过，随后通用旁路、路由 / 隧道故障、错误密钥修复、许可过期和直接模式恢复均成功。使用两台一次性 VM、正常管理器生命周期和实际内核防护；无账号，付费模型调用为零，两台 VM 与临时数据已清理。

| 注入 | 实际结果 | 范围 |
| --- | --- | --- |
| 重启 systemd-networkd 并续租 eth0 | DHCP 有效期实际更新，HTTP / DNS 可用，防火墙与隧道状态摘要相同 | 本次地址未变；不是 Wi-Fi 切换或所有 DHCP 故障 |
| 系统 DNS 改为 8.8.8.8 / 8.8.4.4 | 清缓存后的解析失败，真实后台因受控 DNS 失效撤销并停机；正常重启修复 | 没有手动调用监测来替代后台检查 |
| 许可状态目录写满 | 用独立 64KB tmpfs 得到真实 ENOSPC；暂停宿主定时检查时，续期失败立即清空内核许可，已有流停止、新连接失败；恢复检查后自动停机，正常重启可恢复 | 只覆盖 `/run/mucodesandbox-lease` 状态写入失败；不是整个系统盘或项目盘写满恢复 |
| 双向阻断对端 UDP | 原有持续响应停止，新请求在约 4.2 秒的观察中超时失败；后台约 188.9 秒后检测握手失效并完成停机；解除阻断后正常重启恢复 | 单次测量，不是最大响应时间承诺；握手与管理例外可以继续尝试 |

修复点是许可 helper 在内核续期或状态保存异常时撤销内核许可，撤销不依赖状态目录仍有空间。常规 45 秒许可到期机制保留。

四份完整 eth0 出站 pcap 分别为 2,184 / 1,032 / 2,274 / 32,136 字节，各有批准对端 UDP 正向对照，未批准 IP / IPv6 包均为 0；每份记录 SHA256。抓包直接传到宿主文件，排除已批准的管理 SSH 回复以避免“抓包传输再次被抓包”的反馈，不在客体状态目录积累大文件。此专项不会触发 Mac 休眠或更改宿主网络，报告的 `actualMacSleepTested` 和 `actualWifiSwitchTested` 均为 false。

## 剩余边界

历史 `wireguard-kernel.json` 的 `productionModeImplemented: false` 是原型当时的范围，不能作为当前集成状态。当前本机测试模式已实现；真实公网 / 住宅对端仍为未验收。

仍须完成：真实出口批准及不同目标源地址、地址变化等更多网络故障、整盘写满与断电恢复、首次账号设置 / 更多 CLI 工具与模式 / 版本、包内完整故障与桥接 / 快照流程、休眠 / Wi-Fi 切换和长时间运行。新模式首次开机、浏览器 / CLI 本地任务、实际包基本交互终端已有独立证据，四项网络故障范围见上节。双 VM 的 eth0 抓包不能替代真实公网接收端 SYN 或住宅来源证明。旧镜像缺少 wireguard-tools 时会拒绝启动，须使用新受保护环境，或先在原代理模式安装该组件。多对端、预共享密钥、域名端点、IPv6 和分流路由尚不支持。详见 [设计与阶段](plans/2026-10-10-wireguard-design.md)。

该结果不会把 Linux 浏览器变成 Mac；若隧道后仍有代理重新建立 TCP，还须重新观察最终接收结果。住宅 HTTP / SOCKS 代理账号本身不提供 WireGuard 对端，也不能由客户端自动转换为整包传输。没有封号风险或账号结果的保证。

## 保留失败

- `wireguard-faults-before-bpf-fix.json` 及同名目录：实际网络服务重启、DHCP 续租和防护摘要检查成功，但 Mac tcpdump 拒绝复核脚本中的协议 / 主机组合表达式，整轮失败。改为显式 `udp and dst host ...` 等表达式，再从全新双 VM 重跑；没有放宽包的允许范围。
- `wireguard-kernel-before-nat-syntax-fix.json`：接收端 NAT 规则缺少必要换行，尚未进入隧道比较。
- `wireguard-kernel-before-capture-flush-fix.json`：真实握手与 HTTP 成功，但抓包仅有文件头；当时不能验证 SYN。修为立即捕获，并要求两端实际 SYN 和非空抓包后重新完整运行。
- `wireguard-runtime-before-routing-normalization.json`、`wireguard-runtime-before-route-diagnostics.json`、`wireguard-runtime-before-iproute-json-fix.json`：真实对端握手成功，但 iproute2 JSON 的路由表类型、`not: null` 和 `suppress_prefixlen` 字段未被正确读取，启动被拒绝并停机。依据实际输出修正读取后重跑整个双 VM 测试；没有放宽批准的路由内容。
- `wireguard-workloads-before-bounded-capture.json`：首次开机核验和 CLI 安装成功，浏览器依赖安装时，全包长时间抓包占满客体 `/run`，许可续期写入失败，管理器撤销并停止 VM。此轮整体失败；它不是磁盘写满与恢复专项已经完成的证明。抓包改为仅记录出站包、截取 128 字节包头。
- `wireguard-workloads-before-interaction-coordinate-fix.json` 及同名目录：实际浏览器画面、页面 / Worker 身份、Cookie 与 renderer sandbox 通过，但固定鼠标坐标没有点中按钮，未进入 CLI 任务。另发现旧命令输出大小上限截断了抓包传输，同名目录中的 `workloads.pcap` **没有有效文件头，不可作为网络验收证据**，不采用该失败报告中的 capture 成功字段。新脚本扩大受限传输上限，并要求传输字节数等于客体文件大小、文件头有效，再保存和检查全部输出包。
- `wireguard-workloads-before-cut-fallback-fix.json` 及同名目录：浏览器、正常资料重开、CLI Write / Read / Bash、真实 PTY 中 Ctrl-C 已通过；截断流后，CLI 改用非流式请求重试，旧模拟服务返回了完整有效的 Write，标记文件被创建，整体失败。这个结果不是“不完整 JSON 被执行”的证据：当时模拟服务实际补发了完整指令。修复模拟服务，CUT 在流式与非流式两种方式下都只返回不完整内容并断开，增加实际 HTTP 关闭回归；新包也单独检查此行为。先前透明模式的主动取消记录仍是当时观察，不能据此推断未覆盖的重试路径。
- `capture-audit-before-phase-positive-control-fix.json`：独立复核错误地要求首次开机文件已有隧道 UDP；实际该段在 WireGuard 配置前结束，只有管理 / DHCP。改为按阶段要求开机 SSH / DHCP、后三组实际 UDP / SSH 正向对照后，四组完整文件复核通过，未改变拒绝条件。

实现参考：[WireGuard 路由说明](https://www.wireguard.com/netns/)、[sing-box DNS 入站](https://sing-box.sagernet.org/configuration/inbound/direct/)、[iproute2 规则输出源码](https://github.com/iproute2/iproute2/blob/v6.1.0/ip/iprule.c)。

这些失败没有被当作防护通过。第一次启动较慢时保留原运行任务，检查其真实状态并等待，未因观察超时重新启动另一项测试。
