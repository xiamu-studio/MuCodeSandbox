# Mac 浏览器出口限制：兼容性验证

日期：2026-10-10。当前默认继续采用受保护 Linux VM 浏览器。Mac 浏览器已有独立资料与身份配置，但本机强制出口尚未通过验收。

## 实际复验

`npm run test:mac-chromium` 在全新临时资料中运行本机 Google Chrome 155.0.8059.40，真实账户、用户原有浏览器资料和付费模型均不参与。`test-results/mac-chromium.json` 记录 2026-10-09 17:47:29 至 17:47:42 UTC 的结果：

- 普通启动通过指定本地代理加载合成页面；页面与 Worker 的平台 / User-Agent 相同，Canvas 可用。
- 显式要求 Chromium sandbox，实际启动参数中没有关闭 sandbox 的开关。这个参数检查不是内核沙箱状态的完整证明。
- 加上继承式 Mac 进程网络策略后，出现 `sandbox initialization failed: Operation not permitted`；网络服务与 GPU 进程失败，启动超时，受限阶段页面和代理命中均为零。
- `passed: false`、`enforcementAccepted: false`。不能因为没有收到流量就认定浏览器防泄漏通过。

独立 Chrome 与之前 Electron 的 `mac-browser.json` 出现相同初始化失败。因此该问题不限于 Electron 窗口实现；不能推断所有其他 Mac 防护机制都不可用。

## 排除的前置问题

独立 Chrome 首先因默认拒绝 Unix socket 而无法绑定资料单实例通信端口。失败报告保存在 `mac-chromium-before-private-ipc-fix.json` 和 `mac-chromium-before-system-ipc-fix.json`。Mac Chrome 忽略本实验的 `TMPDIR`，仍将单实例 socket 放在系统临时目录。测试只允许匹配该目录下 Chrome 单实例 socket 的绑定 / 接收；没有开放连接其他资料 socket 的权限，也没有扩大 TCP / UDP 允许范围。越过这个前置问题后，才观察到上述内部沙箱初始化失败。

最早的 `mac-chromium-before-command-line-fix.json` 是验收脚本缺少 `--enable-automation`，无法读取启动参数，不作为受限浏览器行为证据。

## 使用边界

这是一项 Headless Chrome 兼容性诊断，不是原生 Mac 浏览器产品验收、完整图形 / 字体兼容性验收或封号风险测试。脚本固定本机可执行文件，新建并删除自己的资料，不启动对手应用。测试失败保留为失败，不关闭 Chromium sandbox 来得到绿色结果。

后续原生 Mac 路线必须有实际网络进程的独立出口边界，并逐项覆盖直接 TCP、DNS、UDP / WebRTC、IPv6、后台进程、代理故障与重启。代理配置成功、页面平台相同和没有 Apple 开发者账号分别是不同事实，不能相互替代。

单实例 socket 的用途见 [Chromium 源码](https://chromium.googlesource.com/chromium/src/+/8496f370f/chrome/browser/process_singleton_posix.cc)，浏览器进程隔离设计见 [Chromium Sandbox](https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md)。
