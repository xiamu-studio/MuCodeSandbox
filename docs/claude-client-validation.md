# 真实 Claude Code 的无账号验收

## 当前 cf031a2 包透明 / WireGuard 复验

透明模式完整流程见 [串联记录](packaged-workflow-validation.md)。同一包
的实际 Electron / 全新双 VM WireGuard 专项于 2026-10-10
17:53:44–17:57:34 UTC 完成，17:57:57 UTC 独立复核通过。
包签名 `cf031a2a4bbc9d55cc8b1d97e77a935b312145d2`；报告
`claude-tui-wireguard-network.json` 与同名 `-evidence.json`；原始目录
`claude-tui-wireguard-network-1791654824954/`，报告 SHA-256
`f47006dfaec0e9232aff1c0ecc857426b236ba2645b7566e82b5af039ab5ab8f`。

从包内 API 冷安装官方 Claude Code 2.1.296 / Node 24.15.0，真实原生
终端执行 Write / Read / Bash：拒绝、单次授权、Escape 后同进程恢复、
历史重开与关闭终端后宿主 PTY / 客体 CLI / 响应退出通过。没有 blanket
allow。独立内核 WireGuard 对端在任务阶段禁止公网转发；浏览器三阶段
真实显示 Cookie / localStorage / IndexedDB：首次、对端断线失败后
恢复、客户端重启后均保留。实际直连旁路被拒绝。

四份原始物理接口抓包独立复核：外发 189 / 52476 / 186 / 331，批准
对端 UDP 0 / 40058 / 0 / 20，未批准外发均为 0。首次与重启抓包各
匹配不同实时 boot ID。五个检查点宿主网络监测正常；测试对端实际
1 GiB、客户端 2 GiB，复用官方缓存。临时 VM / 数据均已删除。

无账号、付费调用 0。没有首次真实账号设置、所有工具 / 模式、公共
住宅对端、实际 Mac 休眠 / 切网或全天测试；历史其他专项不自动转移。

## 历史验收

日期：2026-10-10。历史透明模式源码验收与新增整包隧道 / 实际安装包验证分别记录。

`npm run test:claude-client` 于 2026-10-09 17:33:38 至 17:35:33 UTC
通过。实际 Linux VM 内为 Claude Code 2.1.295、Node 24.15.0，以 dev 用户运行。
没有登录 Claude，没有共享宿主配置，没有真实 API 凭据或付费模型调用。

## 实现与实际证据

- 实验室新增 Anthropic Messages 与 token-count 接口，接受固定合成凭据，
  从不转发模型请求。保留原有回环、Host / Origin 和输入大小限制。
- 真实 CLI 收到分段 JSON 工具参数，依次调用 Write、Read、Bash。实际文件
  内容正确，工具回执中用户为 dev，三个工具结果均非错误，并完成流式响应。
  没有使用 bypassPermissions 或关闭开发用户权限限制。
- 安装依赖阶段与客户端测试阶段分开。后者代理只允许映射到本地实验室的
  `203.0.113.80:80`；拒绝 DoH 与外部正向探测。测试窗口两份抓包分别有
  212 / 184 个物理出站包，仅批准代理、管理 SSH 和 DHCP，无物理 IPv6。
- 实际任务引擎取消尚未结束的流，服务观察连接关闭，管理账户确认客体 CLI
  已退出。诊断 action 按现有 Manager 规则使环境显示 error，测试通过普通
  restart 恢复；不把它写成现有交互终端已有 Claude 专用任务取消按钮。
- 一个实际忽略 SIGTERM 的 guest Python 进程先打印自身 PID，再超时。源码
  报告 TIMEOUT，随后确认该 PID 不存在。验证不是只关闭本机 SSH 连接。
- 中断尚未完成的工具 JSON，CLI 自动重试；观察两次真实中断后主动取消重试。
  未执行不完整 Write，目标标记文件不存在，CLI 进程退出。随后新文本任务成功。
  **没有证明 CLI 会自行在短时间内报最终失败**，也不将测试主动取消写成自然失败。

客体开发命令现在由短期 Python supervisor 以原 dev 身份执行，参数和 stdin
保持原样；每条命令有独立进程组、内核抽象 Unix socket 和截止时间。取消走
第二条管理 SSH 中的同身份控制请求，检查 Unix peer UID；超时在客体本身终止
对应进程组。交互 PTY、管理 root 维护命令和主动另建会话的脱离进程不在此项
清理证明内；网络故障仍由已有 VM 防护和停机机制处理。

## 失败与回归

`claude-client-before-remote-cancel-fix.json` 保留最初真实取消失败：宿主任务
已标记 cancelled，但响应连接仍未断开。这促成 `server/guest-task.ts` 修复。
`claude-client-before-state-recovery-fix.json` 保留诊断 job 进入 error 后继续
使用业务接口被拒绝；测试改用管理通道观察，再走普通 restart。
`claude-client-before-disconnect-observation-fix.json` 保留客户端重试超过
90 秒而触发测试超时，未被当作自然断线失败通过。

最终 `test-results/claude-client.json` 为 passed，原始输出和两份抓包在
`test-results/claude-client/`。CLI 输出中的 costUSD 是按合成 usage 字段本地
估算的值，**不是账单**；测试没有到真实模型服务的获准连接。

63 项自动测试与构建通过；客体命令 supervisor 加入后，实际透明网络的
curl / Python / Git / Node、DNS、HTTPS、安装、绕过拒绝、代理和隧道故障、
恢复与显式直连回归通过，报告始于 17:27:31 UTC。

## 新增隧道与实际安装包验收

上一轮 `npm run test:wireguard-packaged` 于 19:11:48 至 19:19:14 UTC 通过，报告现保存在 `wireguard-workloads-before-lease-storage-fix.json` 及同名目录。全新两台 VM 中实际 CLI 2.1.295 的 Write / Read / Bash、流式工具参数、原生 PTY 内 Ctrl-C 后退出与 shell 恢复、截断响应后取消重试与新任务成功，均经内核 WireGuard，任务阶段禁止出口 VM 向外部转发。无账户、付费调用 0。

实测发现 CLI 可在流式失败后改用非流式重试。旧模拟服务在该路径意外返回完整 Write，实际创建了标记文件，失败记录为 `wireguard-workloads-before-cut-fallback-fix.json`。这是模拟服务补发完整指令，不能称为 CLI 执行不完整 JSON。修复后两类请求都截断，真实重试中没有创建标记；由测试主动取消重试，不宣称自然最终失败。

当轮候选 CDHash `e0db1f5bf97702f7856cd23fa238cd5f00f9832e` 实际启动隧道与 Electron 原生 PTY，CLI 实际完成同样三个工具，读取真实结果确认用户 dev，Ctrl-C 关闭响应且 shell 可继续使用。包内 Messages 的两类截断路径另由实际包导入测试覆盖；这不等同包内 CLI 截断 / 超时全流程均已覆盖。

许可写入故障修复后的上一轮全新两 VM 回归于 19:38:20 至 19:47:03 UTC 通过，实际安装 CLI 为 2.1.296 / Node 24.15.0。相同源码工具 / 流式 / PTY 中断 / 截断取消与新任务恢复再次通过；候选 `107273602295547086e659cb939bfac4b64cc82b` 在 19:46:22 至 19:47:03 UTC 实际窗口内完成浏览器和同样三个 CLI 工具 / Ctrl-C。历史报告为 `wireguard-workloads-before-native-identity-acceptance.json`，完整抓包独立协议复核通过，无账号、付费调用 0。此轮仍不是完整 TUI 或包内全部故障验收。

浏览器原生语言 / 新窗口修复后的最新回归于 20:23:08 至 20:30:49 UTC 通过，仍为实际 CLI 2.1.296 / Node 24.15.0。源码的三个工具、流式参数、PTY Ctrl-C、两类截断后取消重试与新任务恢复重新通过；候选 `5f305193359bcbe113e07dc86d944236da327101` 的实际窗口阶段为 20:30:08 至 20:30:49 UTC，包内相同三个工具和中断恢复通过。报告为 `wireguard-workloads.json`，四份完整抓包独立复核通过；无账号、付费调用 0。仍不覆盖完整 TUI 或包内全部故障。

上述历史测试均为 `claude -p` 在实际 PTY 或任务引擎运行。新增源码 / 实际包透明代理与实际包 WireGuard 的基本交互测试见后文；其他 CLI 版本、更多工具 / 子进程、更广包内取消和故障、全新 Mac、付费在线账户与 Claude Desktop 仍待验收。源码 / 包内任务各有物理抓包，完整字节数与协议复核通过，范围见 [整包隧道验证](wireguard-validation.md)。旧包和完整性报告另存 `*-before-cut-fallback-fix`，更早报告保存在 `*-before-wireguard-integration.json` 与 `*-before-port-policy-fix.json`。

## 新增真实交互界面验收

`npm run test:claude-tui` 最新于 23:37:39 至 23:40:17 UTC 通过，使用全新一次性
严格透明 VM、真实 CLI 2.1.296 / Node 24.15.0、生产网页终端的实际 PTY 和
xterm 界面。不是 `-p`，没有 blanket allowedTools、bypassPermissions、
宿主账号共享或付费调用。报告为 `claude-tui.json`，截图、屏幕文本、原始
终端输出和 pcap 在 `claude-tui/`；测试 VM / 数据已删除。

- 在实际菜单选择拒绝 Write，目标文件仍不存在；下一轮真实请求保留
  `is_error=true` 的拒绝结果。拒绝本身会结束当前轮，不要求虚构模型回执。
- 下一轮分别批准 Write 与写文件的 Bash，批准前文件均不存在，批准后
  内容正确。真实 Write / Read / Bash 结果成功，命令以 dev、UID 502 运行。
  只读 Bash 被 CLI 正常策略自动放行，不将其记成手工批准。
- 对尚未结束的流按 Escape，服务观察连接关闭；同一 CLI PID 继续成功
  完成下一轮。退出后 `--continue` 恢复，实际请求的用户轮数由 5 变 6。
- 关闭终端页面时，真实 guest CLI 退出、响应关闭、宿主 PTY 记录移除。
  这不证明任意脱离会话的后台子进程都一定随之退出。
- 直接绑定物理网卡的绕过失败；前后规则和隧道配置指纹一致。抓包完整
  136413 字节，955 个物理 IP 输出，其中 451 个批准代理包，未批准 0。
  `verify-claude-tui-evidence.ts` 在 23:40:55 UTC 独立复核代码 / 文件 SHA256、
  菜单与回执、真实 eth0 索引 2 和协议过滤，通过。

**首次账号设置未验收。** 首次正常交互启动仍执行官方地址联网检查，在
仅允许本地夹具的网络中失败。测试改用官方 `IS_DEMO=1` 跳过首次设置，
以 `ANTHROPIC_AUTH_TOKEN` 配置固定的本地合成网关凭据。没有修改 CLI、
注入“已登录”文件或放开真实服务。该设置仅用于本地验收脚本，未加入
产品的正常 `claude` 启动入口。[官方环境变量说明](https://code.claude.com/docs/en/env-vars)。

测试服务已修复历史指令覆盖当前轮、合并消息中的旧拒绝结果污染新轮的
问题，并为新一轮工具分配独立 ID。等待流增加换行后，真实界面能显示
尚未结束的文本；此前仅无分隔符单词会停留在缓冲区，不宣称是网络失败。
拒绝 / 授权 / 恢复的基本 TUI 流程已验收，不代表所有工具和模式已覆盖。

失败记录依次保留在 `claude-tui-before-connectivity-check`、
`claude-tui-connectivity-diagnosis`、`claude-tui-before-gateway-auth`、
`claude-tui-before-readonly-policy-check`、`claude-tui-before-denial-observation`、
`claude-tui-before-merged-turn-results`、`claude-tui-before-wait-rendering` 和
`claude-tui-before-resume-readiness` 的 JSON / 同名目录；不是通过记录。
最后一次复用 VM 的通过记录另存 `claude-tui-reused-vm`。
共享验收流程拆分前的全新 VM 通过记录另存 `claude-tui-before-shared-workflow`，
其中保留当时完整验证器，不能将旧源码指纹当作新代码运行证据。

新 `release/tui-candidate` 包 CDHash `7d6e3ea1d0b2b22ec466c2f1652279e5ca7bc37e`
已包含测试服务修复，完整性、资源篡改拒绝和实际包内多轮 / 合并拒绝接口
通过。新增实际 Electron 交互测试见下节，独立于源码网页终端记录。

## 实际安装包的交互验收

`npm run test:claude-tui-packaged` 第一轮于 23:37:38 至 23:40:52 UTC 通过。
真正启动上述 7d6e3ea 应用包，使用独立 Electron 资料目录，通过包内 API
创建全新受保护 VM、确认未安装 CLI，再由包内安装入口冷安装 CLI 2.1.296。
源码运行器只承担合成文件准备、独立进程观察和抓包，不承担 CLI 启动。

源码与包共用 `claude-tui-workflow.ts` 的实际交互步骤，包内原生终端完成
拒绝 / 单次授权、真实工具结果、同 PID 中断恢复和退出后 5→6 轮对话恢复。
关闭终端页签后，Mac 上应用所属的 limactl / ssh 真实 TTY 进程均消失，
Linux CLI 退出且流连接关闭；主窗口仍打开，随后重新检查防护并拒绝物理
网卡绕过。没有把主窗口退出导致的整机停机当成终端清理通过。

第一轮抓包完整 136581 字节，959 个物理 IP 输出，批准代理 440 包、未批准 0。
23:41:36 至 23:41:37 UTC 独立复核包签名、全部包内服务器文件指纹、截图、
回执、真实进程记录和 pcap 通过；所有自有临时 VM 与两类资料目录已清理。
该轮记录和当时验证器另存 `claude-tui-packaged-before-os-sandbox-check`，
后续增加窗口系统沙箱状态检查的运行独立保存，不覆盖该历史结论。

当前 `claude-tui-packaged.json` 为第二轮全新 VM，23:42:08 至 23:44:32 UTC
通过。通过 Electron 实际进程指标另确认窗口 renderer 的系统级 sandboxed=true，
窗口启用 sandbox / contextIsolation、关闭 Node 集成且无禁用 sandbox 参数。
实际宿主 TTY 与客体 CLI 的退出、全部基本交互步骤重新通过；抓包完整
137381 字节，956 个物理 IP 输出，批准代理 446 包、未批准 0。23:45:16 至
23:45:17 UTC 独立复核通过，临时 VM / 两类资料目录已删除。构建检查通过。
这些窗口检查属于 Electron 显示界面防护，不等同 Linux 网页进程或 Mac
系统级出口已经通过同一检查；后两者仍按各自专项记录评估。

本节透明代理交互使用官方演示模式与本地模拟响应，不验证首次账号设置、
真实账号 / 付费服务、任意后台子进程、全部工具和网络故障。WireGuard 另验。
它也不继承其他候选包的浏览器 / 快照事务故障记录。

## 实际包 WireGuard 交互验收

`npm run test:claude-tui-wireguard` 于 23:51:02 至 23:54:05 UTC 通过，实际
7d6e3ea 应用包通过包内 API 新建严格客户端、冷安装 CLI 2.1.296 / Node
24.15.0。另一台独立 VM 运行真正的内核 WireGuard 对端和固定地址接收端。
源码运行器只准备测试对端、合成文件、进程观察及抓包，不代替包内启动 CLI。

安装后以实际 nft forward 规则双向阻断客户端地址的公网转发；外部 HTTPS
失败，本地 Messages 仍可达。对端接收连接的实际源均为 10.77.0.2，拒绝
计数器为 15 包。任务只用本地模拟响应，没有账号、真实凭据或付费调用。

共用实际交互流程完整通过本轮规定的基本步骤：拒绝 Write 后文件不存在、
下一轮保留拒绝历史、单次批准 Write / 写文件 Bash、真实 Write / Read / Bash
成功、Escape 后同 PID 继续、退出后新 PID 恢复 5→6 轮、关闭终端页签后
真实宿主 limactl / ssh TTY 和客体 CLI 均退出、响应断开。主窗口仍打开且
网络防护有效，规则 / 隧道摘要不变，物理接口直连尝试失败。

首次开机抓包 23048 字节、216 个物理 IP 输出、批准对端 UDP 2 包；任务
抓包 150235 字节、981 个物理 IP 输出、批准对端 UDP 454 包。两份均无
未批准输出。客体 eth0 索引实际为 2；首次开机有 DHCP 正向对照。独立
代码 / 包签名 / 截图 / 回执 / nft 规则 / 原始 pcap 复核于 23:55:37 UTC 通过，
报告为 `claude-tui-wireguard.json` 与对应 `-evidence.json`，产物目录同名。
两台自有 VM 与两类临时资料目录已清理，构建通过。

本轮不重验旧包浏览器 / 快照，不覆盖所有 CLI 工具与子进程、真实住宅
对端、休眠 / 切网或长期故障；首次账号设置仍未验收。基本交互通过不代表
不会封号，也不把本地接收源地址当成最终公网出口来源证明。

共享模拟服务修复后，print 模式于 23:25:16 至 23:28:27 UTC 在另一台全新
严格 VM 重新通过。当前 `claude-client.json` 为 CLI 2.1.296：实际三个工具、
任务引擎取消、忽略 SIGTERM 的任务超时清理、两次截断后主动取消重试及
新任务恢复，两份抓包分别有 214 / 188 个物理出站包，仅批准出口。历史
2.1.295 通过报告和原始产物另存 `claude-client-before-tui-fixture`。

协议依据：[Messages 流](https://platform.claude.com/docs/en/build-with-claude/streaming)、
[CLI 参数](https://code.claude.com/docs/en/cli-reference)、
[环境变量](https://code.claude.com/docs/en/env-vars)。
