# 0.4.9 日志目标与出口验收

2026-10-12（台北）。本机应用 `/Users/staff/Applications/MuCodeSandbox.app`，build `3f85a86d88438db1`，CDHash `e739ef327c468d1f0de1874f16055d46e93c67ce`。桌面快捷入口沿用原路径。

## 已交付

- 目标网址：已观察的网站域名，服务器 IP 显示在下方。同一连接的入站域名与解析地址准确关联；仅 DNS 对照时标注来源，多域名共用 IP 时不猜测。
- 沙箱出口 IP：每条新记录保存事件发生前最近的有效核验回执及时间。锁定路线有效窗口 45 秒；未来、失败、过期回执不代替历史。未启用锁定时的检测回执与核验标签不同。
- 没有旧回执的记录明确显示缺失；不会填入当前或配置的 IP。搜索支持域名、服务器和出口 IP。
- 不解密 HTTPS，不保存完整网址路径、查询参数、Cookie 或正文；不改代理、DNS、防火墙或出口批准策略。

## 验证

- 254 / 254 单元测试；跨日志批次、连接 ID 重用、DNS TTL、共享 IP 歧义、不同启动 / 服务实例、未来和失败出口、资料与代际隔离。
- 1320 / 800 / 390px 页面没有整体横向溢出；表格可独立滚动。域名 / 出口搜索、失败过滤、历史空态通过。
- 深度严格临时签名、封装依赖与本地合成场景通过。安装模块与当前源码编译结果哈希一致，运行版本及 build 已核对。
- 实际 `美国 VPS · 全新环境` 请求 `https://www.google.com/` 得 HTTP 200。日志显示 `www.google.com`（DNS 对照）、服务器 `142.251.151.119`、此前核验出口 `166.88.36.199`；三处出口服务的连接域名也已准确关联。
- 本机应用 AX 中实际显示新版列和上述记录。防护 active / integrity verified / leaseActive、出口 verified；旧环境仍停止。没有清空浏览器资料、复制旧环境资料或登录真实账号。

原始材料：`test-results/network-destinations/{unit.log,ui.json,desktop.png,package.json,installed.json}`。首轮交付检查脚本因没有继承宿主环境变量导致 Lima 提示 HOME 缺失，已修正验证脚本后重新通过；原失败保留为 `installed-harness-error.json`，不是虚拟机或产品功能失败。

## 边界

这是连接元数据与检测端出口回执的对照，不是每条连接目的网站对来源 IP 的确认。加密 DNS / ECH、没有可用 DNS 对照或采集缺口时仍可能没有确切域名。UI 仍只显示最近 300 条，数据库有数量及最长七天保留限制。没有扩大为全天或全部目的端证明。

实现：`server/network-observations.ts`、`server/manager.ts`、`server/store.ts`、`shared/network-observations.ts`、`src/NetworkActivity.tsx`。
