# 0.4.15 桌面客户端直接启动与浏览器分离

## 原因与调整

0.4.14 的 `Manager.desktopAction(start)` 调用 `browser.open(..., false)`；Chrome launcher 同时启动 TigerVNC、Xsettings 和 PulseAudio。`false` 只是避免弹出 Mac 浏览器窗口，仍启动客体 Chrome 并导航到首页。这就是点击桌面应用却看到 Chrome 的原因。

0.4.15 改为 `ensureDisplay`，独立 `mucodesandbox-display.service` 只运行画面和输出音频。Chrome 与 Grok / Claude 客户端分别绑定显示服务，彼此不依赖。桌面启动不执行 Chrome 下载、启动、CDP 附着或浏览器资料兼容性检查。

| 操作 | 当前行为 |
| --- | --- |
| 桌面应用 → 打开客户端 | 启动受保护显示服务和选定客户端；不自动打开 Chrome |
| 浏览器 → 打开 / 关闭 | 启动 / 正常退出 Chrome；保留显示和桌面客户端 |
| 桌面应用 → 关闭 | 关闭选定客户端，保留资料 |
| 停止 / 重启 / 隔离环境，退出主应用 | 撤销访问、关闭显示及依赖客户端；资料保留 |
| 浏览器维护（恢复 / 升级 / 重置浏览器） | 当前仍先关闭显示会话；桌面客户端会关闭，资料不迁移或清除 |
| 彻底重建 / 删除环境 | 沿用完整旧磁盘及本应用管理副本清理，不带旧资料 |

显示会话与程序之间共享同一客体用户，不是程序之间的强隔离。若用户先手动打开 Chrome，再打开客户端，已有 Chrome 不会被擅自退出。

## 密钥环提示

截图的 “Choose password for new keyring” 是 Linux GNOME 密钥环要求创建加密凭据保险箱；不是 Chrome 首页、不是网站账号登录。客户端通过官方 Secret Service 依赖产生提示。无账号测试可以点 Cancel，仅取消当前创建提示；没有初始化时以后可能再出现。真实使用需由用户自行创建 / 解锁密钥环。没有设密码、没有空密码或明文存储降级；真实账号登录及持久化仍暂缓。

## 验证材料与当前范围

- `test-results/desktop-display-separation/unit.log`：272 项通过；覆盖不调用 Chrome、浏览器关闭保留连接、原进程防护和完整退出路径。
- `ui.json`：临时数据界面确认桌面画面不依赖 `browserRunning`，1320 / 800 / 390px 不溢出；不是实际 VM 画面验收。
- `package.json`：0.4.15 / build `51945327356e2bdb` / CDHash `016108d728dc11ecb2643a1ce5e10807a7d56be0` 本地临时签名与深度包完整性通过；不是 Apple 公证。已替换并运行本机应用，安装副本深度严格签名检查通过。
- `actual.json`：实际 VM 两客户端独立启动时 Chrome unit 均 inactive / PID 0，root 进程检查没有 Chrome；同时打开 Chrome 时检测到15个 Chrome 进程作为阳性对照。单独关闭 Chrome 后 Grok MainPID 保持不变，防护 active / integrity verified。
- `native.json`：Mac 解锁后实际安装与两个未登录欢迎窗口通过。Claude 全屏可见 Get started；Grok 从本机“打开客户端”直接启动，画面完整且没有 Chrome 首页。两次密钥环创建提示均只点 Cancel。当前留下 Grok 未登录欢迎页，旧环境继续停止。

本轮没有重新做长期网络 / 断线故障或整环境重建测试；采用既有防护流程并检查当前完整性。不是账号登录或付费任务验收。

计划：[桌面显示分离](plans/2026-10-12-desktop-display-separation.md)。没有登录账号、付费调用、浏览器源码构建或环境重建。
