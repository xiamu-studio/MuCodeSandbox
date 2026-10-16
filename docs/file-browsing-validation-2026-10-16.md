# 文件夹浏览、文件时间与 Linux 文件管理器

2026-10-16，**0.4.53 / 99a70e14f9c2ea95 已安装并恢复原沙箱**。用户确认保存工作和结束传输后，正常停止、退出并更新。

## 问题与改动

- 原传输工具只列出三个根目录里的单文件，没有子目录和可见时间，导致上传、下载与导出混淆。新面板按“下载 / 导出 / 传入”分别读取，支持进入子文件夹、面包屑和返回上一级。目录在前，文件按修改时间倒序；紧凑上传入口保留，路径/说明收起。
- 文件显示Mac本地时区的完整修改日期与时间，列表显示读取时间。首次读取不标“新增”；有完整先前列表时才标本次刷新新增，同名版本发生变化时标已更新。修改时间不等于实际导出时间，不推测文件是否来自某个网站或是否已完成业务导出。
- 下载附带列表里的目录与版本指纹。文件在列出后或读取过程中更新时，不将不同版本交付给用户，提示刷新后重试。仍只传输≤25MiB的普通文件，不打包文件夹，不自动上传给网站。
- 路径仍锚定在三个允许目录下；逐级O_NOFOLLOW目录描述符检查、普通dev所有者、同设备目录、硬链接/FIFO/越界拒绝，保留调用前后授权与环境版本检查。旧分页接口兼容，新目录分页游标绑定目录，禁止换目录混用。

## Chrome “在文件夹中显示”根因与准备

现场只读检查：没有thunar/nautilus/pcmanfm等文件管理器，也没有dbus-launch；Chrome主进程未配置DBUS_SESSION_BUS_ADDRESS。已通过原受保护客体网络从Ubuntu官方仓库安装Thunar4.18.8与dbus-x11，模拟/实际仅新增15个包，0升级、0移除；没有推荐的自动挂载/云盘组件，没有字体或资源调整。

Ubuntu包提供org.xfce.Thunar服务，但没有独立org.freedesktop.FileManager1激活文件。新增root所有的固定本地服务定义，将标准名字交给Thunar；在独立dev D-Bus会话中的只读Introspect已成功返回ShowItems。新启动器使用dbus-run-session，继承原User=dev、BindsTo显示服务、KillMode=control-group与浏览器隔离参数。

候选准备时旧Chrome进程不能打开目录。新版重开后，已通过CUA从Chrome内置下载页点击文件夹按钮，确认Thunar打开Downloads并选中对应文件；随后放大窗口并切换为列表视图。没有访问实际AI页面或打开文档正文。

## 验证范围

- 48项相关后台测试通过：目录/旧传输、浏览器启动、桌面、链接交接、任务监督、联网许可及独立出口核验。
- 目录UI、原文件面板打开、文件与中文输入、四入口快捷工具本地回归通过。覆盖单层目录/面包屑、时区日期、更新提示、旧文件下载拒绝、51项分页、390与520像素布局及关闭后的状态隔离。
- TypeScript、生产构建与安装包检查通过（严格签名、依赖、合成协议、加密备份回环及篡改拒绝；非公证）。安装包检查另见`test-results/package-integrity.json`。
- 相比已安装0.4.52：仅guest-browser-runtime、guest-display-runtime、guest-exchange、service四个服务端模块变化，新增guest-file-manager；其余60个逐字节一致，包括底层防火墙、代理、manager、许可、出口检测、密钥存储、任务监督等。未放宽两份独立有效一致出口要求。
- 真实VM文件管理组件、标准接口与Chrome目录按钮均已验证。Thunar以普通dev用户运行，并处于浏览器服务控制组；没有读取真实文件正文、发起模型请求或传送用户文件。

证据：`test-results/file-browsing/`中的candidate.json、ui.json、目录界面截图与组件检查；测试源见`tests/guest-directory.test.ts`、`scripts/verify-directory-ui.ts`。截图仅使用本地合成文件，不保存用户下载列表截图到仓库。

标准依据：[freedesktop File Manager接口](https://wiki.freedesktop.org/www/Specifications/file-manager-interface/)、[Thunar官方接口实现](https://mail.xfce.org/pipermail/xfce4-commits/2019-January/105954.html)。

组件安装后当前0.4.52生产环境的防护active/verified、许可有效；普通客体用户访问ipify与icanhazip均为166.88.36.199，见`components-protection.json`。这属于当前运行版本的检查，不能代替0.4.53安装后核验。

## Installed verification (2026-10-16)

User confirmed saved work and finished transfers. Normal stop/quit completed; staged application passed strict codesign verification, then replaced the installed app. The old 0.4.52 app remains at ~/Applications/.MuCodeSandbox-before-0.4.53.app for rollback. Start and browser-open jobs both succeeded. Only the configured local homepage and Chrome's internal downloads page were opened.

API and native UI confirm 0.4.53 / 99a70e14. CPU/memory/disk, identity, network, shares and ports match the pre-update baseline. Key inode/size/0600 mode and configured status match. /workspace, browser root/Default and existing client roots retain directory identity/permissions/ownership; account contents were not read.

Protection is active/verified with a valid lease and matching approved rule/configuration hashes. Ordinary guest HTTPS checks to ipify and icanhazip both return 166.88.36.199. Thunar runs as ordinary dev UID 502 inside mucodesandbox-browser.service's display-bound cgroup.

Native Chrome Show in folder opened Downloads and selected the corresponding file. Thunar was enlarged and switched to list view. The native transfer panel shows the three roots, read time and full modification timestamps. The live directory API returns scoped metadata/revisions and rejects path=.. with HTTP 400; no user document contents were downloaded. Fine-grained nested navigation, changes and concurrent-download rejection retain the synthetic fixture evidence above.

Evidence: test-results/file-browsing/before.json, installed.json, live-directory.json, file-manager-process.json, native-ui.json. No GitHub upload in this turn.
