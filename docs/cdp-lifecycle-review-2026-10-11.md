# CDP 生命周期依赖审查

日期：2026-10-11。对应设备处理方案第 6 项。本项只读现有实现并整理依赖；**本批保留常驻 CDP 与自动附加，没有改变 Target / Runtime 流程**。固定桌面普通窗口 resize 已不再发送尺寸操作，但尺寸选择、检查、启动和正常关闭仍有 CDP 依赖。没有 `Runtime.enable` 只能说明当前代码未订阅该域，不能证明 CDP 对网页不可察觉或目标网站无法检测。

## 当前状态与事件模型

`server/guest-browser-runtime.ts:startGuestBrowser()` 启动 Chrome 时将调试地址限制在客体 `127.0.0.1:9222`。`GuestBrowserHost.openVersion()` 通过现有私有 SSH Unix socket 转发访问；`DevTools.open()` 从 `/json/version` 得到浏览器级 WebSocket，拒绝非回环地址，WebSocket 消息上限 2 MiB。没有把 CDP 端口开放到宿主公共网络。

`DevTools` 为每个命令维护 `pending`、序号和 15 秒超时；socket 关闭会拒绝所有等待命令。`Target.attachedToTarget` 先加入 `activeSessions` 再调用 attached 回调，`Target.detachedFromTarget` 先删除 activeSessions 再调用 detached 回调。`activeSessions` 包含已附加的各种 target；`Entry.sessions` 只保存页面 targetId → sessionId。

`configure()` 设置 `autoAttach:true`、`waitForDebuggerOnStart:true`、`flatten:true`，排除 browser、tab、browser_ui，其他类型仍匹配。每个附加目标再执行一次递归 `Target.setAutoAttach`，然后 `Runtime.runIfWaitingForDebugger`。此时原生 TZ / LANG / 浏览器偏好已在启动流程设置；当前没有逐页 locale 覆盖或假设备属性注入。

attached 配置任务加入 `Entry.configuration`。启动流程等待任务集合清空，查询 `Target.getTargets`，必要时手动附加最初页面，再等待并重新读取有效页面 session 后 `Page.navigate`。这样可以处理发现页面期间才发生的附加、导航替换 session，以及 popup / Worker 的子目标。

## 按功能的依赖

| 功能 / 方法 | 当前 CDP 与 session 依赖 | 直接关闭 autoAttach 或 socket 的影响 |
| --- | --- | --- |
| `openVersion()` / `configure()` | 浏览器调试就绪、自动 / 手动附加、configuration 屏障、最初页面导航；ready 发布前再次授权 | 初始页可能未有可用 session；仍处等待调试状态的目标需要先恢复；socket 关闭会触发关闭整个当前浏览器 |
| 新页面 / popup / 子目标 | attached 递归附加与 resume；新 page 更新 sessions；detached 删除旧映射 | 新页面无法被当前 sessions 表发现；Worker / popup 配置顺序和 detach 竞态需要替代处理 |
| 配置故障关闭 | 活跃目标配置异常记录 failure 并关闭当前 Entry；已脱离的 Worker 视为正常竞态 | 事件消失后这条异常关闭依据不再存在，不能只删回调而继续声明同一故障覆盖 |
| `resize()` / `configureGuestDisplay()` | 找到 sessions 中仍 active 的 page；`Runtime.evaluate` 读取原生 screen；`Browser.getWindowForTarget` 与 `setWindowBounds` | 缺少页面跟踪便无法确认原生 screen 或找到目标窗口；RFB 能改屏幕，但不能单独证明浏览器密度与逻辑尺寸匹配 |
| `inspect()` | `Target.getTargets` 查页面，查 sessions，`Runtime.evaluate` 读取真实 TZ / locale / UA / platform / CPU / 内存近似值 / screen | 检查接口失去可用 session；不得用保存配置代替真实读数 |
| `localCheck()` | 导航受控本地接收端、读取固定探针结果、执行无账号模拟请求 | 该测试流程仍需临时页面 session；不是日常业务访问必须永久执行的命令 |
| `update()` 候选验证 | Browser.getVersion、inspect、页面 Canvas / Worker 验证、验收后导航 | 升级候选验收与发布需要可用调试连接；应与日常常驻附加分别评估 |
| 正常 `closeEntry()` | 撤销音频 / tickets / viewers、删除 Entry、等待 displayOperation，再 `Browser.close` 尝试正常保存，等待 socket 最多 5 秒后关闭连接 / SSH / 客体进程 | 若已断开 CDP，要提供同样有界的正常关闭 / 资料保存替代方法；不能以杀进程完全替代正常退出 |
| 保护故障 / 隔离停机 | Manager 先撤销访问与 VM 代际；故障关闭可跳过 Browser.close 的正常退出等待 | 撤销入口与进程停止不能依赖临时附加成功；重构必须继续优先关闭访问 |
| VNC 查看与输入 | 画面和键鼠本身走受认证 RFB / SSH，不通过 CDP 注入输入 | 技术传输可独立；但当前 CDP socket 关闭会结束 Entry，因此现在不能直接拆开后宣称查看持续可用 |

保护链条需明确分开：`assertProtection()` 调用 `inspectGuestBrowserSandbox()` 读取客体进程 / sandbox 状态；Manager 检查网络保护、宿主休眠 / 网络变化、代际和出口许可。这些不是靠 `Runtime.enable` 或自动附加实现的网络防护。CDP 的当前作用主要是目标生命周期、尺寸 / 实际值读取、正常关闭与候选检查。CDP 断开在 `openVersion()` 的 close 监听中会关闭当前 Entry，避免留下旧管理会话；原 Entry 身份检查防止误关替代会话。

## 本批为何保留

现在只设置 `autoAttach:false` 或关闭 socket，会使依赖 session 表的尺寸和检查失效，跳过新页面事件及现有配置失败处理，还可能留下等待 resume 的目标。先去掉 Runtime.enable、改字符串或固定屏幕也不能消除这些依赖。当前源码未提供替代的目标跟踪与正常关闭协议，因此本批保留连接，先完成已授权的稳定发行版、真实设备配置、显示和音频工作。

本次固定模式降低日常 resize 引起的 screen 读取 / 窗口调整频率；这是功能结果，不作为 CDP 检测或账号安全承诺。没有运行网站指纹 / 风控实验，也没有绕过任何目标网站检查。

## 未来最小附加的候选路径（未实施）

优先评估“保留浏览器级控制连接，页面只在必要操作时附加”。先以目标发现 / 创建 / 销毁事件维护 targetId、类型、windowId 和会话代际，再将 session 获取封装为有界的 attach → 操作 → resume / detach。尺寸、inspect、候选验收与本地检查应清楚标记何时需要页面读取；能在浏览器级完成的窗口操作不用扩大页面附加。

切换前必须处理已暂停的目标，确保所有仍等待调试的 session 得到 resume，且 setup / teardown 失败仍关闭访问。新日常目标应不再依赖 pause / 递归 attach 才能正确设置时区和语言；目前原生启动设置提供了候选基础，但仍需验证所有页面、Worker、iframe 与 popup。正常 detach、导航换 renderer、Worker 提前退出必须与真正操作失败区分，不能把旧 session 错误写入新 Entry。

若进一步希望日常完全断开浏览器级连接，还需提供独立且有界的进程健康 / 客体守护跟踪、真正浏览器退出 / 资料落盘方式，以及不会因 reconnect 间隔失去保护关闭的 lease / watchdog。VNC ticket、音频撤销、网络隔离、代际校验必须独立生效；不能以轮询存在证明所有异常窗口已覆盖。该路线属于未来生命周期重构，不在本批执行。

## 未来验收门槛与现有证据

必须覆盖首开 / 重开 / 保存资料；新 tab / popup / Worker / iframe；导航更换 session；目标在附加 / resume / detach 中消失；浏览器 / SSH / CDP 断线；renderer / GPU / 网络保护失败；多查看窗口；固定 / 自适应 / 全屏；inspect；候选检查；正常退出与隔离退出；显示或检查在停机期间返回迟到结果。每项需检查功能与访问撤销，不能只比较 `navigator.webdriver` 或一次 JS 结果。

现有 `tests/guest-browser-initialization.test.ts` 记录发现目标期间附加、旧 session 替换、无替代脱离、共享 opener renderer 的 popup 与原生检查；`guest-browser-lifecycle.test.ts` 区分正常 Worker 脱离与活跃目标配置失败；`guest-browser.test.ts` 覆盖查看授权 / 撤销、异步保护竞态、正常关闭与故障关闭；新增 `guest-display-session.test.ts` 覆盖串行授权和显示迟到结果。这些证明当前受测行为，不证明未实施的最小附加路线已通过。

本项交付为依赖记录与后续验收方案，没有更改 CDP 开关、附加范围、暂停 / 恢复策略、网络边界或浏览器参数。
