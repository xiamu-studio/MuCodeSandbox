# 正式 .deb 安装恢复验证

批准包为Google Chrome stable155.0.8059.39 / ARM64 / .deb，固定摘要与recipe见 `server/browser-releases.ts`。独立临时VM / dataDir，合成Cookie / localStorage / IndexedDB，无真实账号 / 模型调用，不修改生产VM。

- 真正的.deb解包入口失败后，旧二进制、canary与安装记录保留。
- prepared / backed-up / switched / configured / committed五阶段实际暂停并SIGKILL安装器，逐次正常恢复。
- 初始、五次恢复与最终共七份浏览器状态：二进制摘要、策略、recipe与合成资料符合预期，renderer / GPU进程沙箱检查通过，网络防护active / integrity=verified。
- 临时归档实际修改一字节，被批准校验值拒绝；不是修改批准清单。
- 临时VM / fixture / dataDir均已清理。

首次执行在准备基础环境时下载慢而超时，未进入故障阶段，已清理并保留 `test-results/browser-install-recovery-deb-preflight-failure.json`。随后使用本机已有且摘要一致的浏览器 / sing-box缓存。

第二次已完成所有实际安装 / 恢复检查，但旧抓包断言要求客体直连gateway:proxyPort，导致总脚本false。当前路径使用受控反向SSH，物理网卡看到SSH流量。**原报告的false及旧断言错误没有修改。**保留摘要相同的executed-script.ts后，独立复核源码 / 原材料摘要、五次中断、七份状态、合成服务回执及抓包：5386条客体外发均为批准管理网关SSH流量，不允许的外发为0。复核通过，未来演练断言也已修正。

这只证明本次正式包同版本恢复与捕获窗口；不代表真实版本升级、完整Electron包VM故障、全部首包窗口或所有网站逐连接公网来源。

材料：`test-results/browser-install-recovery.json`（原false保留）、`browser-install-recovery-deb-evidence.json`、`browser-install-recovery-1791817296720/`；脚本为 `scripts/verify-browser-install-recovery.ts` / `verify-stable-browser-recovery-evidence.ts`。[设计](plans/2026-10-12-stable-deb-recovery-design.md)。
