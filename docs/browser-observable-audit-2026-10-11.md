# 当前浏览器的自动化标记与系统信息核对

日期：2026-10-11（台北时间）。实际网页采样 **17:59:38**，官方版本
渠道查询 **18:01:30**。本记录与 CLI 四轮审计分开，不混算测试范围。

## 本轮结果

| 检查 | 当前观察 | 怎样理解 |
| --- | --- | --- |
| 自动化接口 `navigator.webdriver` | 三个现有页面，默认 / 临时隔离 JS 世界，共六份读数均为 false | 本轮没有通过该标准接口报告自动化；不证明所有自动化 / CDP 检测不可发现 |
| 属性是否被页面覆盖 | 所测属性无 navigator 自有覆盖，getter 为原生；两种 JS 世界的值完全相同 | 不是只采信页面脚本改写后的结果；不等同于所有指纹均未修改 |
| 实际启动参数 | 未观察到 enable-automation、headless、user-agent 覆盖或 AutomationControlled 抑制；调试端口为固定 9222 | 保留产品现有 CDP 管理通道，没有为了通过检查伪造这些属性 |
| 系统与架构 | 内核 aarch64；可执行文件 ELF AArch64；Client Hints 为 Linux / arm / 64 | 实际为 Linux ARM64；没有伪装 Mac 或 x86 CPU |
| UA / navigator.platform | Linux x86_64，UA Chrome/156.0.0.0；高熵接口版本 156.0.8078.4 | 符合 Chromium 的 UA 缩减规则，不能把固定 UA 平台串当成 CPU 实测 |
| 浏览器品牌接口 | Chromium 156，加一个浏览器原生 GREASE 品牌项 | 本轮网页接口没有直接给出 Chrome for Testing 字样；不证明测试发行版不可被其他方式区分 |
| 语言 / 时区 | 三个页面均为 en-US / Asia/Saigon | 与当前越南环境配置一致；英语不等于必须来自美国 |
| 版本与程序文件 | CLI 版本输出为 Google Chrome for Testing 156.0.8078.4，CDP 版本相同；文件匹配现有批准缓存包 | 核对的是正在运行的这份浏览器，没有下载、重新编译或替换程序 |
| 原环境状态 | 标签数量仍为 3，浏览器仍运行；防护 active / verified，防火墙摘要前后相同 | 未关闭网页、改线路或触发账号操作；不是所有流量的公网验证 |

Chrome 的 [UA Reduction 规则](https://www.chromium.org/updates/ua-reduction/)
将 Linux 的平台文本固定为 `X11; Linux x86_64`，并把 UA 的次版本缩减为
0.0.0。真实架构和完整版本通过其他接口返回。本轮不是项目自行改字段
“凑一致性”，不应因此恢复内核、字体或 UA 伪装改造。

`webdriver` 是 [W3C WebDriver 标准](https://w3c.github.io/webdriver/#interface)
定义的自动化标记。这里的 false 只是一个接口的负结果；产品仍启用
私有 CDP 管理连接，已有 Linux VM 和软件图形环境，不能宣称与物理电脑完全相同。

## 版本渠道仍有缺口

本轮从 Google 官方 [Chrome for Testing 渠道表](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json)
取得的发布时间为 2026-10-10 20:20:06 UTC，最新版本如下：

| 渠道 | 本轮查询版本 |
| --- | --- |
| Stable | 155.0.8059.39 |
| Beta | 156.0.8078.12 |
| Dev | 157.0.8081.0 |
| Canary | 157.0.8097.0 |

当前 **156.0.8078.4 不是本轮表列的稳定版**；156 分支本次在 Beta 行。
该表只给出各渠道最新构建，不能仅凭它断定旧的 .4 构建最初属于哪个渠道。
这进一步说明当前版本不能作为已完成日常稳定浏览器交付的证明。

后续仍需选择受维护的 Linux ARM64 现成稳定发行版并安排升级、资料兼容
和失败恢复。仅换成 CfT 的 Stable 渠道也仍是测试发行版，不自动获得普通
Chrome 的自行更新。不得直接让较旧版本打开现有资料；迁移须有独立副本
或兼容验证。浏览器替换本轮没有执行。

## 方法、原件与限制

- 读取现有桌面 API；仅连接同一 VM 已存在、归当前用户所有的私有 CDP
  Unix socket。没有创建 Manager / Store、启动新 VM 或新浏览器。
- 每个现有页面的主框架采样一次默认 JS 世界和一次临时隔离世界。
  隔离世界只用于读取标准属性，完成后移除本次 CDP 附加会话；没有导航、
  DOM 改动、网络拦截、属性覆盖或新标签。临时 JS 世界由页面生命周期回收。
- 没有读取账号、Cookie、网页文字，也不保存页面标题、地址或原始进程命令行。
- 客体读取实际主进程 UID、执行文件摘要、版本、ELF 架构及选定参数。
  Chromium 子进程可能把完整进程标题放在 argv[0]；不能只以“没有单独的
  --type 参数”把全部子进程误归为主进程。首轮选择器误判已修正。
- 已有缓存包 SHA256 为
  `910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce`；
  安装文件与包内 chrome 成员 SHA256 均为
  `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65`。
  复核直接读取缓存 ZIP，不下载、不解包到新磁盘目录。

采样：`node scripts/audit-browser-observables.ts`。
独立复核：`node scripts/audit-browser-observables-evidence.mjs`。
原件：`test-results/browser-observable-audit/11164890-a87d-405b-b7a0-1e5cf35b22df.json`；
包绑定、渠道回执与复核结果保存在同目录。

本轮不包含 Worker / iframe 的新复测、请求头抓取、完整 Canvas / GPU / 音频
等指纹、所有浏览器检测技巧、真实账号风控或服务端封号判断。
跨上下文的历史范围见 [原验收](browser-context-validation.md)，CLI 的直接
系统查询见 [命令行审计](cli-environment-audit-2026-10-11.md)。不把两者
的有限结果合并成“环境完全无法识别”。
