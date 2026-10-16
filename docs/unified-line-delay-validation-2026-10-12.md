# 0.4.14 Clash 式线路延迟验收

日期：2026-10-12（台北）。本机应用0.4.14，build `bfc9a0a5e9b8de1e`，CDHash `0fe2881b3afa5e99c064b7283051e2639119a288`，深度严格临时签名和封装检查通过。

## 当前主指标

按用户的 Clash Verge 节点列表参考，顶部主显示为“线路延迟”。每轮先发 HTTP/1.1 HEAD 建立连接，再复用连接发第二次 HEAD，测第二次请求往返；三轮中位数作为主值。检测读取 curl 的请求计时，不包含 Mac / SSH 管理命令耗时。

参考本机 Mihomo1.19.31的 unified-delay=true 与 [官方实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.31/adapter/adapter.go#L244)。当前是同类计算方式，并非把 Clash 另一条节点数值直接填进沙箱；测试站点、实现和线路不同，不保证数字完全相同。没有修改 Clash 的全局节点、模式或订阅，原始只读参考在 `access-latency/clash-reference.json`。

## 实测

当前美国VPS166.88.36.199线路，Google204：

| 轮次 | 线路延迟 | 请求状态 | 连接 |
| --- | --- | --- | --- |
| 1 | 199ms | HTTP204 | 已复用 |
| 2 | 193ms | HTTP204 | 已复用 |
| 3 | 202ms | HTTP204 | 已复用 |

中位数 **199ms**，范围193–202ms。首次响应耗时中位数 **1015ms**，作为“网页首次响应耗时”补充展示，不能混称线路延迟。检测后防护active、integrity=verified、leaseActive均通过。没有登录账号、调用模型、重装或清空环境。

0.4.13曾测得Google首次响应1743ms / Cloudflare1255ms，原件保留在 `test-results/access-latency/`，它们不是当前主指标，也未被改写成199ms。

## 验证与边界

- 269项测试通过，含单位转换、三轮统计、连接复用证明、失败不造0ms、站点白名单、HTTPS证书、检测前后批准出口核验、并发合并和环境变化取消。
- UI夹具：顶部 / 详情同步、首次响应单独显示、部分失败、全部失败、防护拒绝、停机 / 换环境清除旧值；1320 / 800 / 390px页面及内部控件边界检查通过。
- 实际本机窗口：顶部199ms、详情199 / 193 / 202ms、补充1015ms已看到并实拍。
- 第二次curl必须num_connects=0；无法复用即失败，不用较慢的新连接结果冒充统一延迟。不跳过证书验证，不回退直连。
- 手动点“测延迟”才产生网站请求；结果只保留在当前应用 / 环境运行周期。停止、改线路或重建会清除，退出后重新测。不是带宽Mbps、不是ICMP ping、不是全天稳定性或每条连接出口证明。

原始材料：`test-results/unified-line-delay/{unit.log,ui.json,package.json,actual.json,native.json}`；[方案](plans/2026-10-12-unified-line-delay-design.md)。

## 使用

在本机应用选中运行的环境，点顶部防护条右侧 **线路延迟 → 测延迟**。要切换测试站点或查看三轮结果，进入 **网络 → 线路延迟**。

![本机实测](../test-results/unified-line-delay/native-current.png)
