# 0.4.4 网络观察与可读日志

日期：2026-10-11（台北时间）。最终本机应用构建 `8b7df815dba491f0`，
安装位置 `~/Applications/MuCodeSandbox.app`。从环境的“日志”页使用。

## 界面和含义

- 出口 IP 观察：每约 30 秒向 IPwho / ipify 两个固定 HTTPS 服务采样，显示本轮跨度、成功 / 失败、不同 IP 数、同一检测端前后变化次数和最后检测时间。可以立即检测、展开历史、下载结构化记录。
- 网络连接与 DNS：显示透明代理的目标 IP / 域名、端口、线路和事件；发起连接、连接失败、DNS 结果与缓存命中分别标记。
- 运行事件：大段浏览器隔离 JSON 改为中文摘要，原始诊断默认折叠。跟随只滚动日志内部，不把出口观察区挤出视野。
- 检测失败、回执过期、采集中断、采样目标 IP 不一致都单独显示。旧历史保留；重启后本轮观察重新开始，不拿旧回执冒充新测量。

当前越南线路没有启用 IP 锁定，页面明确标注。日志采样不自动批准新
出口、不改变线路或既有防护规则。回执一致不证明每个网站都使用同一出口。

## 采集与边界

复用现有 sing-box 的 info 日志，通过专用 systemd journal namespace
读取，不打开控制端口，不解密 HTTPS。只保存目标、端口、事件和时间，
不保存请求路径、Cookie、正文、代理密码或授权头。

客体专用 journal 采用内存存储，限 8 MiB；本机 SQLite 结构化观察最多
10000 条、最长 7 天，界面显示最近 300 条事件与回执。旧记录会自动淘汰。
源端有速率限制、容量限制和读取上限，采集缺口有单独提示，不能称完整抓包。

仅支持严格透明 HTTP / HTTPS / SOCKS5 VM 的连接明细。其他模式明确
标为暂无明细。管理 SSH / DHCP、在内核先被阻断的请求、Mac 其他应用
以及每一条 HTTP 请求均未逐条覆盖。DNS 缓存命中不是一次新的公网访问；
“发起代理连接”不等于网站访问成功，也没有逐连接的真实公网出口证明。
启用前未记录的访问不能补还原。

## 验证材料

最终安装包实机核对通过：构建 `8b7df815dba491f0`，CDHash
`67f3de49a1d64eba5699872ac9b8cfb8dba47ed7`。保存报告时，本轮两处检测端
回执均为 `160.191.52.242`，0 次失败、0 次 IP 变化；实际连接与 DNS
事件已采集，当前无已报告缺口，防护与联网许可有效。具体动态条数和
检测时间以交付 JSON 为准，不代表全天稳定或全部网络访问完整。

- `test-results/network-observations-unit-tests.log`：171 项源码测试通过，0 失败。
- `test-results/network-observations-focused.log`：观察专项，覆盖真实字节数组 MESSAGE、ANSI、目标 / URL 脱敏、重复记录、历史、提供方差异、失败 / 过期、重启跨代丢弃、API 认证和关机先撤销网络许可。
- `test-results/network-real-journal-sample.json`：从实际越南 VM 读取并解析出的连接 / DNS 元数据，排除了原始日志中的其他字段。
- `scripts/verify-network-observations-delivery.ts`：核对安装签名、构建、模块、实际回执 / 连接、有效防护、专用日志限制及截图；最终结果写入 `test-results/network-observations-delivery.json`。
- 原始画面：`native-network-observations.png`、`native-network-events.png`。

现场首次发现 journal 会把含 ANSI 的 MESSAGE 返回为字节数组，早期
解析器未产生连接行；已修复并加入回归。该中间状态不记为最终通过。
最终现场结果以交付 JSON 为准。本轮没有登录 Claude、没有付费模型请求，
也没有恢复休眠、切网、全天等暂缓验收。旧包故障记录不自动转为新包结果。

配置字段来源：[sing-box Log 官方说明](https://sing-box.sagernet.org/configuration/log/)。
设计见 [网络日志方案](plans/2026-10-11-network-logs-design.md)。
