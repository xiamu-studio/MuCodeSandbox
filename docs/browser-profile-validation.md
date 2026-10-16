# Linux 浏览器资料隔离与持久化验证

本验证仅使用本地生成的 `account-a`、`account-b` 数据，不登录 Claude，不调用真实账户或付费模型。

运行 `node scripts/verify-browser-profiles.ts`。脚本新建独立临时数据目录与两台 Linux VM，顺序运行，每次仅启动一台 2 GiB 用户 VM。它不会复用产品数据目录或其他验收任务的数据。

检查项目：

- A 首次访问同一测试站点时没有 Cookie、localStorage 或 IndexedDB 账户数据。
- A 写入持久 HttpOnly Cookie、localStorage 与 IndexedDB 后，关闭并重新打开浏览器仍保留三种数据。
- B 的首次访问无法读取 A 的数据；B 写入自己的合成账户后不影响 A。
- 两台 VM 分别停机并再次启动后，各自仍保留自己的三种资料。
- Cookie 能随浏览器请求发送，但不能从 `document.cookie` 读取。
- 页面、Dedicated Worker、同源 iframe 与请求头分别匹配 A 的东京 / 日语和 B 的纽约 / 英语配置。
- 浏览器资料目录权限为 `0700`，两台 VM 使用不同磁盘文件和 machine-id。
- 整个浏览器访问通过带认证的本地测试代理，并在开启严格透明防护后运行。

结果写入 `test-results/browser-profiles.json`。成功后默认删除脚本自己创建的临时 VM 和数据；失败时保留已经停止的测试 VM 供诊断。设置 `MU_KEEP_PROFILE_TEST=1` 可在成功后保留自有测试数据；`MU_PROFILE_TEST_DATA` 可复用脚本此前创建的 `.mu-profile-verification-*` 目录。复用时首次打开 A / B 之前会清空各自的合成浏览器资料，确保空白检查有效；它拒绝产品或其他任务的数据目录。

额外诊断可设置 `MU_PROFILE_TEST_REPORT=browser-profiles-cold.json` 等文件名，单独保存结果，避免覆盖已经通过的记录。文件名限定为 `browser-profiles` 开头的 JSON 文件，并始终位于 `test-results`。

2026-10-09 的实际验证已通过全部七个资料检查阶段，记录时间为 `14:42:34Z` 至 `14:44:34Z`。两台 VM 的三种存储均独立并保留到重启后，页面 / Worker / iframe 身份与两组配置一致；实际产生 49 次认证代理连接。自有临时 VM 和数据已删除。

验证发现并促成修复了正常关闭浏览器时 Cookie 和 localStorage 丢失的问题：修复前同时终止浏览器与显示服务，修复后先让 Chromium 正常退出并保存资料。修复前的实际失败保存在 `test-results/browser-profiles-before-fix.json`，通过记录独立保存。

首次安装 Chromium 后曾出现 `Page.navigate` 超时，后续复用已安装浏览器的运行通过。冷启动对照已定位到浏览器依赖安装时升级系统组件并重启 `systemd-networkd`，移除了 sing-box 的策略路由；表 2022 仍有 TUN 路线，但没有规则选择它，Chrome 和安装后的 curl 都走回物理接口并被防火墙拒绝。实际防火墙保留完整规则并记录 161 个丢弃包，因此该次证据是断网，不能据此宣称有直连泄漏。修复前记录保存在 `test-results/browser-profiles-cold-netlog.json` 和 `test-results/browser-profiles-cold-network-state.json`。

生产修复后，全新受保护基础镜像和两台全新用户 VM 的默认浏览器路径通过全部七阶段，未启用任何 Chromium 实验开关。最新记录为 `test-results/browser-profiles-cold-fixed.json`，时间 `2026-10-09T15:55:22Z` 至 `16:00:46Z`，共 82 次认证代理连接。两台 VM 的首次浏览器依赖安装后即完成导航；安装前后及重启后的四组证据均显示防护 `active` / `verified`、开发用户路线 `mu_tun table 2022`、普通 curl 无应用代理也成功。五次正常关闭均记录 `profile.exit_type=Normal`。A / B 首次开机抓包分别有 174 / 172 个物理输出包，仅批准代理、SSH 回复与 DHCP，没有物理 IPv6；进入浏览器安装前抓包服务已停止。两份原始抓包独立保存在同名报告的 `-a-first-boot.pcap` / `-b-first-boot.pcap` 文件。

脚本会记录浏览器事件和状态；持续八秒仍未就绪时，提前抓取 guest 目标、日志、网络规则、路线、连接及 Chromium 网络进程所在命名空间。`MU_PROFILE_TEST_FRESH_VM=1` 为复用目录生成全新用户 VM 磁盘，保留脚本自己的受保护基础镜像；`MU_PROFILE_TEST_NETLOG=1` 只为诊断增加浏览器启动网络日志。实验结果使用独立报告文件，不能替代默认生产验证的通过记录。

增加忙任务期间的后台防护检查后，再次以 `MU_PROFILE_TEST_FRESH_VM=1 MU_PROFILE_TEST_REPORT=browser-profiles-egress-regression.json npm run test:browser-profiles` 验证默认生产路径。2026-10-09 16:30:59 至 16:35:52 UTC，两台全新 VM 的七阶段全部通过，自有临时数据已清理。报告保存在 `test-results/browser-profiles-egress-regression.json`；此回归未启用出口批准，出口变化测试另见 [专项验收](egress-validation.md)。

加入防护 v5 内核短期许可及显式 gVisor 转发后，`browser-profiles-lease-regression.json` 于 16:59:10 至 17:03:39 UTC 再次通过默认生产路径七阶段。五次正常退出为 Normal，首次开机 A / B 分别 199 / 216 个物理输出包仅批准代理、SSH 回复与 DHCP，无物理 IPv6。该轮使用全新基础镜像及用户磁盘，临时数据已删除；它证明安装和资料回归，应用崩溃后的断网另由 [实际故障测试](guest-lease-validation.md) 验证。

新脚本还会检查正常关闭后 Chromium 的 `profile.exit_type=Normal`。本脚本每轮 A / B 的首次启动使用全新合成浏览器资料，所以该断言适用；旧资料此前已经显示崩溃恢复提示且用户未处理时，Chromium 可能继续保留 `Crashed`，不能仅凭这一字段断言本次关闭失败。早期七阶段通过记录产生于此追加检查之前，最新冷启动通过记录包含完整的五次正常退出检查。

该验证证明的是两台 VM 的浏览器资料隔离和正常关闭 / 停机后的持久化。它不证明断电恢复、VM 快照恢复、浏览器崩溃恢复、共享文件夹隔离、跨平台兼容或真实账户不会被限制；这些需要各自的验收记录。
