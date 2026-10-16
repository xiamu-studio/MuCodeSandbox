# Code Sandbox 深入复核与桌面方案差距

复核：2026-10-12（台北）。对象是本机 `/Applications/Code Sandbox.app` **0.5.4**，与 MuCodeSandbox **0.4.10** 对照。只读取安装包和提取文件，没有运行竞品、读取账户或进行收费测试。本机这份包不代表官网最新版本。

## 证据与可确认范围

本轮主程序 SHA-256 为 `c8370bb451ce237f25cc93f1e39977de03148c129a89b4981310f52028636459`，与原提取对象一致。签名仍为 adhoc，TeamIdentifier 未设置，CDHash `836f77b678ae3a9b826a1583d6d60890f2f6db62`。

原提取包含 186 个文件、80 个 JS，每个提取文件与二进制片段的校验见 `../../artifacts/code-sandbox-analysis-2026-10-09/verification.json`。完整前次拆包报告见同目录 `分析报告.md`。新增协议和二进制字面量证据见 `../test-results/competitor-desktop-review-2026-10-12.json`。

可读前端、教程、构建清单和函数名不等于完整后端源码；混淆 guestd 的全部实现没有恢复。以下区分直接证据、推断和未验结果，不将一个设置或函数名当成防护通过。

## 按层比较

| 层 / 能力 | 竞品直接证据 | 我们当前实现 | 差距及边界 |
| --- | --- | --- | --- |
| 管理器 | Go / Wails / React，系统 WebKit，独立 code-sandboxd | Electron / React / TypeScript 本机管理器 | 工具不同；界面是 HTML 不代表业务运行在 Mac 浏览器 |
| 开发环境 | Lima、Ubuntu Noble、Linux ARM64 guestd，包含 krunkit 资源 | Lima / Apple VZ / Ubuntu 24.04 ARM64 | 竞品实际所选驱动未动态确认，不能据包含 krunkit 推出 GPU 效果 |
| 浏览器 | macOS ungoogled Chromium 148 镜像、darwin 浏览器模块 | 官方稳定 Chrome 155 ARM64 在 VM 内，Mac 接收画面 | 运行位置和设备图形有区别；包内版本不是实际运行版本的证明 |
| 网络 | macOS sing-box、管理员辅助组件、Linux nft 及出口 / 代理模块 | 客体 TUN / 受控 DNS / nft 默认拒绝，SSH 上游，45秒许可，至少两处新出口回执 | 竞品 Mac 拦截覆盖、首启动及断线行为未动态验，不能称完全等价 |
| 白名单 | 教程说明白名单地址使用本机网络 | 严格业务流量不提供直连备用路线；管理 SSH / DHCP 等另有明确范围 | 允许直连的例外不能当成所有访问同一出口 |
| 权限 | guestd 服务以 root 运行 | 管理 / 安装走受限 SSH，业务与桌面客户端为 dev；另检查 renderer | root 管理服务不等于业务进程一定以 root 运行，需实际取证 |
| 指纹设置 | 平台、语言、时区、Canvas / Audio / WebGL / WebGPU / Fonts 及扰动编辑器 | 保留真实 Linux / ARM / 软件图形，真实地区与固定 2× 桌面 | 不复制伪造路线；配置界面不证明竞品所有上下文一致，更不证明不封号 |
| Desktop 模式 | 独立 / 共享模式、资料 namespace、执行环境 binding、Mac 原生 Claude 适配路径 | 原厂 Linux Claude / Grok 客户端在受保护 VM 内 | 竞品分层更复杂，我们没有共享全局账号资料模式 |
| 客户端适配 | 含 `/Applications/Claude.app`、`desktop-local-origin.cjs`、身份 bundle 和 `--use-mock-keychain` 字面量 | 不改第三方客户端代码，专用 XDG / user-data，GNOME 密钥环 | 证明存在相关代码路径，不证明所有 hook 已启用，不能据此断言凭据明文存储 |
| 宿主桥接 | 教程明确无感 CLI / Desktop 可调用本机任意可执行文件，包括 Shell；分别撤销 | 默认不开放 Mac 文件或 Shell；既有桥接按范围授权、固定三个 Git 命令 | 开放本机权限会扩大边界；独立资料不等于进程之间强隔离 |
| 动作 / 升级 | start/stop/show/clear_cache/uninstall，幂等操作及身份校验；stable/beta 与自动更新 | 固定两官方客户端 install/start/stop，任务锁、防护前后检查、受管生命周期；不静默降级 | 复杂共享切换、原生 Mac 集成、受信自动升级仍不等价 |
| Apple 签名 / NE | 本机包 adhoc，未见正式 NE 组件或授权证据 | 本机包 adhoc，客体 Linux 防护不依赖 Mac NE | 不代表竞品作者没有开发者账号，也不能单靠签名判定防护有效或无效 |

## Desktop 协议定位

`http-desktop-control-DZCt0XsI.js` 明确包含：

- `/claude/desktop/mode` 与 `/claude/desktop/mode/changes`：全局模式读取 / 改变。
- `/claude/desktop/shared/environment-switches`：共享 Desktop 的执行环境切换。
- `/sandboxes/<id>/claude/isolated/status`：按沙箱读取桌面状态。
- `/sandboxes/<id>/claude/isolated/actions/{start,stop,show,clear_cache,uninstall}`：限制动作，使用幂等 key / operation 身份校验。

符号中另有 `DesktopModes.Review/Submit`、`PrepareIsolatedDesktopHandoff`、`DesktopProfileRef`、`DesktopLaunchOwner` 与 `RevokeClaudeDesktopHostIntegration`。模型包含 profile 的 mode / namespace / key、`execution_environment_id` 和 `launch_epoch`。资料归属与任务执行环境是分层概念；编译进去的测试样例不是实际运行状态。

内置教程说 CLI 和 Desktop 配置、会话分别保存，但同一沙箱项目数据可互相访问；停 Desktop 不自动撤销无感 CLI。不能据此把两进程说成彼此不可读数据，也不能把换执行环境说成所有全局资料已清零。竞品真实切换清理仍待无账号动态实验。

## 我们此次补上什么

1. 官方来源固定，验证长度、SHA-256、版本、ARM64；Claude 官方 apt 公钥指纹核对。客户端以普通身份运行，不添加任意命令 / 下载网址接口，不启用 Cowork 大镜像依赖。
2. 启动前 / 后及显示访问沿用网络核验；客户端无需自带代理，TCP 走客体受控路由，UDP / IPv6 仍拒绝。核验失败停止环境，大包安装限速，没有降低批准门槛。
3. 受管 systemd 生命周期，渲染线程 seccomp / NoNewPrivs / UID / 能力检查，并在运行中继续检查。检查仍是采样，不声称抵抗客体 root 或瞬时发现所有风险。
4. Mac 只显示画面，Desktop 不自动扩大文件 / Shell / 剪贴板 / 摄像头 / 麦克风权限。用户既有桥接按能力规则独立管理。
5. 完整重建删除整个旧客体磁盘，覆盖各客户端、默认密钥环、临时 / 诊断 / CLI 文件，即使第三方程序写到配置目录之外也不漏掉。
6. 同时删除本应用的浏览器目录、快照、导入、扩容及恢复副本。此前遗漏的 `restore/<id>` 已补清理，网络观察内存关联也释放。
7. 普通关闭、重开和查看切换保留资料；只有确认的重建 / 删除清空。替代环境新 ID / 新磁盘，不带旧共享、桥接、端口或快照。

## 仍不能保证什么

- 美国出口仍是 VPS 机房；时区和语言不构成美国实体用户或住宅线路证明。真实 Linux / ARM / Apple 虚拟化及软件图形可观察，不伪造或修改内核。合法 VM 本身不等于已证实的封号判据。
- 检测端回执不是每个目的网站对来源 IP 的确认；同一环境还不是同一用户下各应用互相不可读文件的强隔离。
- Grok Bot 的任务使用厂商云电脑，本地沙箱不控制其出口、云文件及历史。[官方说明](https://x.ai/bot)。
- Claude 官方 Linux beta 支持 Ubuntu / Debian ARM64，Cowork 另需 KVM 等条件；当前客体没有 `/dev/kvm`，Computer Use / Dictation 尚不由 Linux beta 提供。[官方 Linux 文档](https://code.claude.com/docs/en/desktop-linux)。
- 不登录账号，真实账号持久化、付费任务、风控和云端记录不在本轮证明范围。手动导出到其他位置的备份和本机共享源文件不自动删除。

## 对竞品做动态对照的验收方法

同一批准线路、同一无账号接收端下，分别验证进程位置 / UID、页面 / Worker / 请求头、DNS / UDP / IPv6、TLS / TCP、首启动、断线和 profile 清理；单独检查共享 Desktop 切换后资料是否保留、CLI 宿主权限是否独立撤销。静态拆包不替代这些实证，也不提供“防封认证”。
