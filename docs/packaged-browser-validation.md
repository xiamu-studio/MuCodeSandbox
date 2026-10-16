# 打包浏览器与终端验证

验证脚本：`scripts/verify-packaged-guest-browser.mjs`。此脚本启动真正的 macOS `.app`，不使用源码服务代替安装包，不登录 Claude，也不调用模型。

## 测试范围

- 使用独立测试数据目录、独立 Electron 用户目录和本机已安装的 Lima 组件；测试结束明确停止虚拟机，再退出应用。
- 本地认证 HTTP 代理只允许 `203.0.113.10`，映射到本地合成网页，其他目的地址拒绝；不需要购买代理线路。
- 检查打包依赖能否加载、应用版本及打包身份，并记录实际签名 CDHash。
- 检查强制透明网络保护已启用，打开浏览器后防火墙与隧道配置摘要没有变化。
- 检查 Electron 原生 PTY 能实际运行交互式命令，Linux 终端用户是受限的 `dev`。
- 检查 Linux 浏览器实际画面为 1280 x 800 且非空，鼠标能操作网页，键盘能通过地址栏跳转。
- 对比网页、Worker、请求头与浏览器检查接口的语言、时区和平台；当前合成测试使用 `ja-JP` 和 `Asia/Tokyo`。
- 检查关闭浏览器后窗口关闭、连接失效；读取真实 `Default/Preferences`，正常关闭必须保存 `profile.exit_type=Normal`；重开后再关闭复验。
- 保存关闭耗时、实际浏览器服务状态与日志。服务状态读取是独立的只读管理检查，不向开发用户开放额外 sudo 权限。

本轮使用数字 IP 的合成网页，不代替 DNS、IPv6、WebRTC 抓包验收，也不证明完整设备指纹或真实第三方账户不会被限制。Linux 平台字段来自实际 Chromium，不表示模拟了完整 Mac 电脑。

## 已发现的打包问题

首个 0.4.0 候选包启动时缺少 `stun` 内置的 `src/node_modules` 文件，实际报错为 `Cannot find module 'message/request'`。这些协议实现是包自带文件，常规依赖打包将其误排除。修复范围同时包含 `stun` 与 `binary-data` 的内置目录，并通过安装包中的实际 STUN 正向对照及签名完整性检查。

最初的启动失败 JSON 已被后续实测覆盖，没有另存历史文件；这里只记录实际观察到的错误，不构造历史报告。

## 关闭状态与旧恢复提示

候选包 CDHash `12759407ddd0f27ecb53f974971328a06e62f4bd` 已通过真实终端、浏览器画面、身份一致性、键鼠交互、连接撤销与网络保护检查。但追加正常关闭检查后，两次关闭后的 `profile.exit_type` 均为 `Crashed`，重开截图也有异常退出恢复提示。

该失败轮实际关闭耗时为 187 ms 和 435 ms；服务检查显示 `Result=success`、`ActiveState=inactive`、`ExecMainStatus=0`，日志记录了显示进程收到信号 15 和 X 连接断开。这些记录不能证明 Chromium 本身以 143 退出。

进一步核对 [Chromium ExitTypeService 源码](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/sessions/exit_type_service.cc)发现：旧异常退出尚未被用户确认时，正常关闭也会保留 `Crashed`，以便用户下次仍能恢复。用户关闭恢复提示或开始新会话后，该保留状态才会解除。因此，上述状态不能单独证明本轮关闭导致了新崩溃。

真实失败资料保存在 `test-results/packaged-guest-browser-before-close-fix.json` 和 `test-results/packaged-linux-browser-before-close-fix.png`。随后通过真实鼠标关闭了旧恢复提示，保持原有 Cookie 和资料不变，未编辑退出状态、未清空资料、未隐藏提示。该轮前后状态保存在 `test-results/packaged-guest-browser-after-crash-ack.json`：开始前 `Crashed`，关闭后和重开关闭后均为 `Normal`。

产品关闭流程增加了最多 10 秒的自然退出等待，避免 CDP 连接先断开而浏览器后台尚未结束时立即终止服务；故障隔离仍及时关闭。没有把上述旧恢复提示当成足以证明关闭竞态的证据。

## 原透明模式验收

0.4.0 上一候选包 CDHash `4a52bba2ddc343153ad2a725f49216720aa7f407`，临时签名 `adhoc`，封装资源 5906 个。2026-10-09 18:44:37 至 18:45:25 UTC，默认命令完整验收通过。包内包含 Messages、客体任务 supervisor、端口映射修复和整包隧道配置 / 生命周期。原 `cfb5cc051b78c4c47690590786eb411579808245` 的报告另存为 `*-before-wireguard-integration.json`。

验收脚本现明确设置 Playwright 的 `chromiumSandbox: true`，并核对实际 Electron 主进程没有关闭 sandbox 参数，避免测试框架默认关闭 sandbox。这个参数检查仍不是 Mac 内核 sandbox 状态的完整证明。修改前同包的测试保存在 `packaged-guest-browser-before-sandbox-harness-fix.json`；最新结果来自加强后的重新实测。此前 CDHash `0bb50d9d4e3ba2fec68ed4466d6e607a43133896` 的报告另存于 `*-before-port-policy-fix.json`，不作为新包凭证。

- `passed=true`，`modelCalls=0`，应用实际为打包的 ARM64 Electron 44.7.0。
- 实际终端为 `dev`；实际 Linux 浏览器 1280 x 800，采样得到 358 种颜色；键鼠交互和语言、时区一致性通过。
- `profileBeforeBrowser`、`browserProfileAfterClose`、`browserProfileAfterReopenClose` 的 `exitType` 都为 `Normal`；截图没有恢复提示。
- 强制网络保护保持启用，浏览器关闭连接撤销，停止后 HTTPS 设置可用。
- `vmStopped=true`，浏览器页面错误列表为空，测试桌面目录和应用进程已清理。

本次复用已有受保护虚拟机，当前候选已完成防护 v5 升级；再次启动、联网与停止均通过。最终停止后读取实际测试目录 `security/mu-b9953e3616f74b64.json`，确认 `version=5`、`bootArmed=true`、`conservative=true`。这是旧环境升级和真实安装包的回归证据，不代替独立进行的首次安装 apt 升级、networkd 重启和冷启动 A/B 验收。

当前包包含出口核验代码，但本脚本未启用出口批准。源码服务的真实 VM 出口故障证据见 [专项验收](egress-validation.md)，不能把两项报告合称为包内出口故障全流程已验收。

包完整性脚本另通过实际 STUN 与包内分段 Messages 服务；最初错误地在原始 SSE 文本中匹配完整回答，因回答分段而失败，报告保存在 `package-integrity-before-sse-assembly-fix.json`。按已有实验室方式解析 JSON 事件并拼接 text delta 后重新通过。这是合成协议检查，不是包内真实 Claude Code 全工具流程。

该包另实际导入编译后的 WireGuard 验证、配置与 DNS 模块，生成受限配置并核对不产生连接代理 URL。历史报告 `packagedWireguardConfiguration=true`，`packagedWireguardVmWorkflowVerified=false` 仅反映那项模块检查；该浏览器回归使用原透明代理模式。新增实际包整包隧道任务见下节。

同样，源码真实管理子进程的硬退出已通过 [内核许可验收](guest-lease-validation.md)；本包脚本未杀掉 Electron 进行故障测试，不将源码结果称为打包进程故障证明。

## 当前包的整包隧道任务

当前候选 CDHash `5f305193359bcbe113e07dc86d944236da327101`，完整资源临时签名 5906 个；`package-integrity.json` 于 20:20:03 UTC 起通过，实际 STUN、Messages 流式 / 非流式截断、WireGuard 编译模块、deep / strict 和篡改拒绝通过。上一轮 1072736 包保留在 `release/candidate-before-native-browser-identity-fix/`，更早包和对应旧报告也另存。

`npm run test:wireguard-packaged` 实际运行此包，`wireguard-workloads.json` 及目录中 `packaged-workloads.json` 于 20:30:08 至 20:30:49 UTC 的包内阶段通过：

- 正常启动受保护 WireGuard VM，实际 Electron 窗口显示 1280 x 800 Linux 浏览器，颜色采样 339 种；键鼠、390 像素查看器与语言 / 时区检查通过。未关闭 Chromium sandbox。
- 实际鼠标点击网页后产生第二个页面目标，新窗口和其 Worker 的身份与原页面一致，请求语言为 ja-JP；原生日期语言 ja 的匹配检查通过，没有再发生 locale override 冲突关闭。
- 保留源码阶段的 Cookie / localStorage 资料，真实关闭后读取 Normal。
- 通过包本身签发终端票据、加载 Electron 原生 PTY，以 dev 实际执行同轮冷安装的 Claude CLI 2.1.296 的 Write / Read / Bash，检查实际文件，并执行 Ctrl-C / shell 恢复。
- 本地模拟服务固定在测试出口 VM，业务任务期间双向外部转发阻断；防护指纹不变，物理抓包 165,983 字节 / 1,083 个 IP 输出包。独立完整文件协议过滤通过，只有批准对端 UDP 与管理 SSH。
- 正常停止 VM、退出实际 `.app`，两台测试 VM 和数据目录删除。

这是安装包本身的实际运行，未把源码结果合并充数。安装包复用同轮源码阶段新建、冷安装完成的 VM；不等同全新 Mac 或在包内完成全部首次组件下载。新增网络 / DNS / 许可目录 ENOSPC / 对端断线四项故障由源码管理器另验，当前包包含同一修复，但没有把这些源码结果写成包内全部故障通过。完整 Claude TUI、包内截断 / 超时 / 更多工具故障、出口批准、硬退出、桥接和快照仍需单独验收。详细冷安装、故障与保留失败见 [整包隧道验证](wireguard-validation.md)。

## 结果文件

- `test-results/packaged-guest-browser.json`：最近一次真实安装包实测结果，检查 `passed`、`signature`、关闭后的实际偏好和 `vmStopped`。
- `test-results/packaged-linux-terminal.png`：实际安装包中的 Linux 终端。
- `test-results/packaged-linux-browser.png`：实际 Linux 浏览器画面。
- `test-results/packaged-linux-browser-reopened.png`：关闭后重开的浏览器画面。
- `test-results/packaged-guest-browser-after-crash-ack.json`：确认旧恢复提示的实际测试轮。

运行方式：

```sh
node scripts/verify-packaged-guest-browser.mjs
```

脚本默认使用明确的 `.mu-transparent-verification-*` 测试目录，拒绝其他目录。需要切换准备好的候选包或测试目录时，使用 `MU_PACKAGED_APP` 和 `MU_PACKAGED_GUEST_DATA`；已有 Lima 组件可通过 `MU_LIMA_PATH` 指定。

`MU_ACK_PREVIOUS_CRASH_PROMPT=1` 仅用于这个已知旧测试资料的恢复提示诊断：在固定浏览器画面中实际点击一次关闭按钮，并保存截图。默认验收命令不使用此选项。
