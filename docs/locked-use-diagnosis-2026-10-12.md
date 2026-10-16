# 锁屏操作失败的本机诊断

检查日期：2026-10-12至2026-10-13。本文件记录只读诊断，以及用户通过官方安装器手动完成正常安装的结果；代理未手动覆盖系统插件、编辑macOS授权数据库或绕过系统认证。

**2026-10-13 10:32最新结果：组件版本不同步已修复。** 用户运行项目手动入口并完成本机管理员认证，官方安装器返回安装成功。随后独立复读系统插件为26.1005.1001425，与当前电脑操作服务及安装源一致；系统插件通过 `codesign --verify --deep --strict`，OpenAI Team ID为2DC432GLL2。实际锁屏自动操作尚未测试，N30仍保留这一步；无需再次重复安装或重新配置开关。

10:37至10:39尝试实际测试：原生工具读取MuCodeSandbox完整窗口树和画面成功，没有自动解锁失败报错。读取前系统未报告 `CGSSessionScreenIsLocked=Yes`；随后从10:38:34至10:39:19连续45秒监测也未捕捉到该标记。因此本次只证明普通窗口读取可用，不能证明锁屏自动解锁成功或失败。已请用户实际锁屏后从另一连接设备确认；期间不操作Mac键鼠。不重新安装组件，不以旧报错认定此次失败。

2026-10-13安装修复之前的复核：用户回复“已重新配置，并看到 Mac 桌面”后，原生读取、正常退出 / 打开MuCodeSandbox、恢复环境及全屏操作全部成功，0.4.21 / cc5b2f659e4a0d63已交付。当时只读重读系统安装插件仍为26.812.1000717、当前服务仍为26.1005.1001425，正常配置后仍未同步。该结果证明解锁后的操作可用，不能证明实际锁屏自动解锁已修复，也不能据版本差异断言全部失败根因。未更改权限、覆盖插件或绕过锁屏，不再次以解锁提醒代替组件修复。

## 已确认

- 用户截图中“锁屏操作”已开启。不能把失败解释为用户没有开启开关。
- 当前 ChatGPT 为 26.1007.30912 / 20156，标识 `com.openai.codex`。
- 当前使用的电脑操作服务位于 `~/.codex/computer-use/Codex Computer Use.app`，磁盘版本为 **26.1005.1001425**。
- 应用内提供的锁屏授权插件也是 **26.1005.1001425**。
- 早前 `/Library/Security/SecurityAgentPlugins/CodexComputerUseAuthorizationPlugin.bundle` 安装的是 **26.812.1000717**，与服务摘要不同；10:32正常安装后已同步为 **26.1005.1001425**，系统安装副本的完整签名验证通过。
- `system.login.screensaver` 已注册 `com.openai.sky.CUAService.AuthorizationPlugin.remote`，该规则调用 `CodexComputerUseAuthorizationPlugin:allow`。因此不是“插件完全没安装 / 没注册”。
- 本线程之前的工具报错明确包含“automatic unlock could not unlock it”，不是只检查到了锁屏就停止；最后两次发生在 UTC 13:55:43 和 14:07:07。
- 系统日志在本地时间 22:24:59 记录授权插件 `Login authorization socket response=DENY` / `allowed=NO`。该时间不同于上面两次失败，不能把它直接当作两次失败的根因证明。
- 本轮新建应用连接已成功读取和操作 MuCodeSandbox，并完成 0.4.18 更新；普通窗口操作能力目前可用。

## 判断

早前存在明确的**组件版本不同步**，现已通过正常官方安装修复。但日志没有给出每次拒绝的理由，尚不能证明所有失败都由旧插件造成；组件修复不等于实际锁屏功能已验收。

官方文档说明：锁屏操作只对正在进行、受信任的电脑操作任务临时解锁；授权窗口短暂，检测到本机键鼠输入会重新锁定并暂停自动解锁，直到用户手动解锁。因此“开关开启”与“每次请求都被批准”不是同一件事。[官方 Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)

## 修复与验证

2026-10-13补充只读检查：应用内的 `Codex Computer Use Installer.app` 通过 `codesign --verify --deep --strict`，签名为 OpenAI OpCo, LLC（Team ID `2DC432GLL2`）。其实际命令入口支持 `install|uninstall|status`；执行 `status` 返回 `OK: installed`。这个状态不含版本，不能据此判定安装副本已更新。系统插件仍为26.812.1000717，安装源与服务为26.1005.1001425。当天系统日志同时存在08:25:51授权失败（-60005）及之后授权成功，但没有足够关联证据区分手动解锁与电脑操作自动解锁。

用户已使用应用自带、已核验签名的安装器重新执行 `install`，并在本机完成管理员认证。下面保留本机发现的官方安装器入口，不是公开文档承诺的通用排障命令；路径只适用于当前安装。代理没有代为运行安装或卸载。

```sh
"/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/MacOS/Codex Computer Use Installer" install
```

安装后复读系统插件版本；即使版本同步，也须实际锁屏后从连接设备发起一次只读窗口检查，才能验收功能。若安装器出错或副本仍旧，保存安装器输出继续排查，不直接改授权数据库或覆盖插件文件。

本项目提供 `scripts/repair-locked-use.command` 作为本机手动入口：先验证官方安装器的完整签名及OpenAI Team ID，再调用其 `status` / `install`，最后读取系统副本和安装源的版本。脚本没有手动复制插件、编辑授权规则或保存密码。用户已实际运行，安装器显示 `OK: Installed`，安装副本和源均为26.1005.1001425；代理已独立复读版本和签名确认。

1. 用户在当前设置页通过正常界面重新配置“锁屏操作”，若出现系统安装 / 管理员认证，须由用户在 Mac 本机完成。不能由代理直接覆盖系统插件或代输管理员密码。
2. 早前仅重新配置开关后仍留下旧版本；用户本次通过已核验的官方安装器完成正常安装，系统副本已与服务同步。不再把版本不同步列为当前故障。
3. 用户锁屏后，通过手机或另一连接设备发送一个只读的 MuCodeSandbox 窗口检查请求；测试期间不要在 Mac 本机操作键鼠。
4. 同时记录该次工具结果与对应时间的系统日志。只有实际锁屏自动操作成功，才能标记“锁屏操作已恢复”。

电脑操作工具不允许操控 ChatGPT 自身或批准系统安全提示，故正常重启ChatGPT及本机管理员认证由用户完成。用户已正常更新授权插件；代理没有关闭锁屏保护、直接改权限或自动重启ChatGPT。下一步按脚本提示正常重启后锁屏，从连接设备发起只读任务，结合工具结果和对应时间日志验收。

## 证据位置

- 系统插件：`/Library/Security/SecurityAgentPlugins/CodexComputerUseAuthorizationPlugin.bundle`
- 当前服务：`/Users/staff/.codex/computer-use/Codex Computer Use.app`
- 应用内安装源：`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle`
- 原始本线程记录：`~/.codex/sessions/2026/10/11/` 下对应线程 JSONL；未复制其他会话内容或私密配置。
