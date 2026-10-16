# Linux 浏览器跨上下文验收

日期：2026-10-10。本次实际运行于 2026-10-09 20:17:35 至 20:22:38 UTC。
入口：`npm run test:browser-contexts`。报告：`test-results/browser-contexts.json`。

## 实测范围

使用两台全新严格透明代理 VM、正常产品启动和浏览器安装流程。A 为 `ja-JP` / `Asia/Tokyo`，B 为 `en-US` / `America/New_York`。每台分别验证首次打开、关闭重开和 VM 重启，共六阶段、42 次上下文测量。全部通过，测试 VM 与临时磁盘已删除。

| 检查 | 结果 |
| --- | --- |
| 页面、DedicatedWorker、SharedWorker、ServiceWorker、同站 iframe、跨站 iframe、新窗口 | 七种实际上下文都返回数据；对应真实目标类型与脚本 URL 检查通过 |
| 时区、网页语言、日期语言、CPU / 内存、UA、Client Hints、Canvas、字体宽度 | 七种上下文的共同字段一致，时区及网页语言符合配置 |
| 请求头 | 实际服务器收到的 User-Agent 与浏览器报告一致，Accept-Language 以配置语言开头 |
| SharedWorker | 页面和同站 iframe 使用同一真实实例标识 |
| ServiceWorker | 实际注册、激活、页面受控、Cache API 读写通过；A / B 同地址分别从空开始，只保存自己的合成标记，关闭重开和 VM 重启后保留 |
| 真实字体 | `fc-list` 库存、浏览器实际使用字体和 Canvas 字宽均检查；实际使用 Liberation Sans 与 WenQuanYi Zen Hei，虚构字体作为回退反向对照 |
| 架构 | 客体 `uname -m` 为 aarch64，Client Hints 为 Linux / arm / 64；没有修改 UA 或平台接口 |
| 网络 | 四份实际 eth0 出站抓包有批准代理流量正向对照，未批准包为 0；防护摘要未变化 |
| 正常关闭 | 六次均检查真实 Preferences 的 `exit_type=Normal` |

日期语言 A 原生返回 `ja`，网页语言返回 `ja-JP`；B 两者为 `en-US`。验收要求语言相同、返回的地区若存在则与配置相同，并要求七个上下文的日期语言完全一致。产品检查同步采用此规则，错误语言、冲突地区、错误网页语言和时区的反向测试均通过。

Linux 的 UA / `navigator.platform` 原生包含 `Linux x86_64`，高熵 Client Hints 则报告真实 ARM64。Chromium 的 [UA Reduction 文档](https://www.chromium.org/updates/ua-reduction/) 明确规定 Linux 的固定平台文本；本项目保留此原生行为，不把固定 UA 文本当成实际 CPU 架构，也不为“修一致性”重写它。

## 抓包

| 文件 | 字节 | 批准代理出站包 | 未批准包 |
| --- | --- | --- | --- |
| a.pcap | 2422732 | 16268 | 0 |
| b.pcap | 2123471 | 13334 | 0 |
| a-restarted.pcap | 36108 | 148 | 0 |
| b-restarted.pcap | 45532 | 258 | 0 |

每份记录 SHA256。明确例外为批准代理 TCP、管理 SSH 回复和 DHCP；IPv6 不在放行范围。浏览器上下文页面位于客体回环，不会产生外部网页流量，因此另用真实 HTTPS 请求及安装流量证明抓包不是空白。

## 修复与保留的失败

旧版本对每个页面调用 locale override。实际新窗口在短暂共享 opener renderer 时返回 `Another locale override is already in effect`，应用因此关闭整个浏览器。现改用启动器的 TZ / LANG / LC_ALL、Chromium 语言参数和资料语言设置，移除 Linux 页面的 Emulation 覆盖；真实七上下文与新窗口已复测。目标附加、暂停与恢复逻辑仍保留。

首轮缺少关闭原因的失败、捕获 locale 冲突的失败、字体就绪等待超时、严格字符串比较误报分别保留在 `browser-contexts-before-*.json` 及对应目录中。字体专项只测系统字体，已去掉可能等待页面布局的 `FontFaceSet.ready`，不声称覆盖异步网页字体。四个已停止的失败测试数据目录随后删除，记录见 `browser-contexts-failed-data-cleanup.json`；JSON 与 pcap 保留。

## 限制

- 本历史记录的虚拟显示环境七种上下文 WebGL 均不可用，`gpu=null`，当时不能称为 GPU 渲染通过。2026-10-10 新生产软件 GL 配置有单独的 [图形验收](browser-gpu-validation.md) 与 [媒体验收](browser-media-validation.md)；没有关闭 sandbox 或伪造 GPU，也没有将新结果写回旧报告。
- 使用实际 `127.0.0.1` 与 `localhost` 的两个不同站点和安全上下文；未使用“不安全地址视为安全”开关，也没有证书绕过。此项不代表公网 HTTPS、证书处理、任意第三方嵌套和所有站点隔离策略都已验收。
- 字体覆盖固定的五组系统字体与三个样本文本，不覆盖全部字体、网页字体、音频指纹、WebGPU 或所有图形 API。
- 此报告来自源码管理器。实际 Mac 安装包 5f30519 的新窗口与网络 / CLI 验收随后于 20:30:08 至 20:30:49 UTC 通过，见 [安装包验收](packaged-browser-validation.md)；包内专项不包含这里全部七类上下文，不混为同一次结果。
- 无账号、付费模型调用为 0；结果不能推断服务商不会封号。
