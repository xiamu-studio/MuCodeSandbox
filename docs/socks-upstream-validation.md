# SOCKS5 上游无账号验收

## 当前试用包出口锁定组合

9621b0a 包于 2026-10-10 23:19:43 UTC 通过双 VM 的 SOCKS5 与出口
锁定组合独立复核：独立 sing-box 服务、认证正反对照、许可开放前
测量、普通用户入口绕行拒绝、错误账号 / 密码拒绝、运行中出口变化 /
测量异常撤销及恢复正确配置后业务成功、文件保留。八份客户端物理
抓包未批准外发 0，两个临时 VM / 数据清理。没有重建应用或浏览器。
这项使用合成出口回执，没有成功 DNS、实际桌面浏览器 / CLI、真实
住宅或全天验收；不宣称普通 SOCKS5 上游链路具有加密。
报告 `egress-bridge-owner-socks5.json` 与对应 `-evidence.json`；
详见 [组合记录](egress-probe-validation.md)。

## 旧 7395e50 冻结包复验

2026-10-10 22:06:34–22:12:32 UTC 使用 7395e50 包内全部 45 个后台
模块完成真实双 VM 重验，22:12:57 UTC 独立抓包复核通过。正确认证 /
特殊字符密码、错误密码 / 用户名 / 未填认证、真正无认证服务、普通
curl / Python、系统 DNS / 公共 HTTPS、错误 DoH 名称拒绝、服务掉线 /
恢复和正常 VM 重启均通过。强制物理直连被内核阻断。

七阶段物理输出为 118 / 60 / 44 / 45 / 27 / 131 / 63，未批准外发
均为 0，全部经过批准 SSH 路径，没有物理代理出口例外。双向物理
抓包看不到合成 SOCKS 凭据与 HTTP 正文；完整客体接口抓包能看到
它们，作为实际采集成功的正向对照。**SSH 只保护 VM 到 Mac 这一段；
Mac 到外部普通 SOCKS5 代理仍不自动加密**，需要加密上游时应使用
HTTPS 代理或具备加密传输的线路。

临时客户端 / 服务端 VM、基础镜像及数据已清理。报告
`socks-upstream-transport.json`，SHA-256
`f8bf8eeeec16d5dd7ceaba12ec3ebe0ad3413d714ab3437a0c5d08dab6bf452b`；
原始目录 `socks-upstream-transport-1791669994559/` 含七份完整抓包、
七份物理接口提取文件和独立 `capture-audit.json`。入口
`test:socks-upstream-transport` 与对应 `-evidence`。
此项不是实际 Electron UI / 浏览器 / Claude Code、住宅线路、全天、
真实 Mac 切网 / 休眠验收；UDP / QUIC / IPv6 仍被阻断。

## 旧源码验证

2026-10-09 21:59:34 至 22:02:50 UTC，完整实际 VM 验收通过。22:02:54 UTC 独立抓包复核通过。本地日期为 2026-10-10。

使用两台独立临时 Ubuntu ARM64 VM：产品管理器正常创建严格透明网络客户端，另一台运行经过 SHA256 验证的 sing-box 1.14.3 SOCKS 服务。宿主 curl 作为独立 SOCKS 客户端先验证服务的认证正反对照。测试使用随机合成密码、本地 HTTP 接收端及公开 DNS / HTTPS 页面，没有 Claude 登录或付费请求。

## 已验证

| 场景 | 实际结果 |
| --- | --- |
| 正确账号与特殊字符密码 | 用户名含冒号 / @，密码含 @、冒号、斜线、#、?、&、=；普通 curl 与不设置代理的 Python urllib 经 TUN 成功 |
| DNS 和 HTTPS | 系统 getent 经代理内的 DoH 成功；普通 curl 访问真实 HTTPS 页面成功 |
| 错误密码、错误用户名、未填认证 | 每次通过正常停止、修改、启动入口；业务失败，接收端无新增请求；强制绑定物理网卡直连也失败且防火墙阻断计数增加 |
| 无认证服务 | 服务端真正关闭认证后，不填写凭据可以正常访问；恢复认证及客户端配置后再次成功 |
| 错误 DoH 证书名称 | 域名查询失败，数字地址的代理请求仍成功；物理网卡没有直接 DNS 或其他未批准输出；恢复正确名称后解析成功 |
| 代理服务停止 | 业务失败、直连失败、接收端无新增请求；恢复服务后成功，正常重启客户端 VM 后也成功 |
| 防护状态 | 重启后防火墙、透明网络、DNS、内核短期许可均有效，完整性 verified |
| 明文正向对照 | 物理网卡双向文件能看到合成 SOCKS 用户名、密码及 HTTP 响应。普通 SOCKS5 本身不加密这一段；网页 HTTPS 的内容仍由网页 TLS 加密 |

七阶段共记录 543 个物理 IP 输出包，其中 151 个为批准代理流量，未批准输出均为 0。允许范围为批准代理 TCP、管理 SSH 回复及 DHCP；物理 IPv6、直接 DNS 和其他输出被拒绝。原始 any 接口文件和独立提取的物理双向文件均保留，SHA256 及实际接口索引写入报告；独立脚本重新检查文件完整性、所测源码指纹、接口、方向、批准目的地及正向流量。

## 复现和证据

```sh
npm run test:socks-upstream
npm run test:socks-captures
```

需要 Apple Silicon Mac、Node.js 24.15+、Lima，以及准备受信镜像 / 组件和访问公开 DNS / HTTPS 所需网络。运行使用自己的 `~/.mu-socks-verification-*` 私有目录；通过后删除全部自有 VM 和临时数据，不修改已有用户环境。失败时停止自有 VM 并保留诊断目录，报告记录路径。`MU_SOCKS_TEST_DATA` 只能复用本验证器在 home 下创建的目录，每次仍新建客户端和服务端 VM。

主报告为 `test-results/socks-upstream.json`；抓包和独立审计位于 `test-results/socks-upstream/`。抓包包含本次合成测试密码，保存在私有目录，不能当作可公开分享的真实用户线路日志。

保留两次未通过记录：`socks-upstream-before-listener-readiness.json` 是服务已启动但本机转发尚未可连接；`socks-upstream-before-capture-direction-fix.json` 是只抓输出却要求检查响应。后者抓包保存于 `socks-upstream/before-capture-direction-fix/`。修复测试准备等待和双向采集后完整重跑，没有放宽产品防火墙。

## 未覆盖

这是源码管理器的协议与故障实测，服务通过本机 SSH 转发可达；不是商业 / 住宅线路、公网分流、代理域名地址变化、长期稳定性或本轮实际桌面包的证明。本轮不运行浏览器或 Claude 任务，已有 HTTP / WireGuard 工作负载验收不能直接归入 SOCKS5。UDP / QUIC / IPv6 仍阻断，不宣称 SOCKS UDP 支持。需要到代理这一段加密时，另选已验证的 HTTPS 上游或 WireGuard。
