# 0.4.10 桌面与环境清理验收

更新：2026-10-12（台北）。**本轮无账号桌面客户端与完整环境清理验收完成。后台、真实 VM、本机应用包及解锁后的实际窗口均已核对；不代表真实账号、付费任务或所有产品化项目完成。**

## 当前交付

- 项目：`/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox`。
- 本机应用：`/Users/staff/Applications/MuCodeSandbox.app`；桌面原入口不变。
- 运行版本 **0.4.10**，build **8053dd4051aba726**，CDHash **a6057d431144a493e8972566a594aaae5dae8a30**。
- 安装包与源码编译模块一致，深度严格临时签名 / 封装验证通过。不是 Apple 正式签名 / 公证。
- `美国 VPS · 全新环境` 保留原配置与资料，4CPU / 4GiB / 30GiB、美国洛杉矶时区、en-US、专用 SOCKS5 24898，批准出口166.88.36.199。原线路环境保持停止。
- 官方 Grok Bot ARM64 **0.68.1**、Claude Desktop ARM64 **2.31226.1** 已安装，未登录、没有付费模型调用。未创建新的完整操作系统。

## 已通过

| 验收 | 结果 | 原始材料 |
| --- | --- | --- |
| 固定来源与安装 | 包长度 / SHA256 / 软件名 / 版本 / ARM64；Claude 官方 apt 公钥指纹匹配 | `grok-desktop-preparation.json`、`claude-desktop-installation.json` |
| 单元与接口 | **261 / 261**；命令 / URL 白名单、来源和路径保护、检查 / 清理失败拒绝、操作确认 | `managed-desktop/unit-final.log` |
| UI夹具 | 1320 / 800 / 390px、客户端操作路由、重建说明 / 取消、无整个页面溢出 | `managed-desktop/ui.json` 与截图 |
| 真实客户端进程 | 两客户端受管启动，renderer 各线程保护与 UID / 能力检查通过，状态回执166.88.36.199 | `managed-desktop/actual.json` |
| 本机真实窗口 | 解锁后通过本机应用按钮打开两客户端，未登录画面、关闭重开、嵌入 / 全屏 / 退出全屏及完整右侧与底部均已看到；真实固定桌面1600×1000 / 2× | `managed-desktop/native-visual.json`、四张 `*-native-*.png` |
| 普通关闭重开 | 实际客户端状态文件保留且稳定，Grok 3个、Claude 2个稳定状态文件；不是写一个测试标记冒充应用持久化 | 同上 |
| 实际断线 | Claude 未登录运行时切断专用 VPS 连接，SOCKS访问失败，环境隔离停机；恢复线路并重核验同一出口，客户端保持关闭 | `managed-desktop/line-fault.json` |
| 完整重建 | 实际临时 VM 八处客户端 / 密钥环 / CLI / root缓存 / 临时 / opt标记全部清零，旧盘 / 快照 / 恢复副本消失，新machine-id不同 | `managed-desktop/clean-rebuild.json` |
| 测试资源清理 | 两个临时环境已删除，用户环境未被重置；自己的多余安装包和更新备份已清理 | 同上及安装模块校验 |

所有原始材料在项目 `test-results/`。三个测试脚本不读取或打印真实账户、Cookie值、SSH私钥或私有管理令牌。

## 本轮发现与修复

1. 原删除遗漏 `restore/<environmentId>` 的恢复中间副本，现已包含在删除 / 完整重建。
2. 进程检查最初对 cmdline NUL 分隔转义及 Electron 改写进程标题的识别有误，导致已启动客户端误判未保护；修复真实解析，并用实际 Python + 两种真实格式校准。原失败保留 `actual-inspector-error.json`。
3. 资料检查遍历遇到 document portal 的 FUSE挂载权限，已将检查限于持久 profile / config，并保留 `actual-portal-walk-error.json`。没有放宽文件权限，也没有把不可读取的目录当成已清理。
4. 未限速安装下载时出现一次不足两个新出口回执，系统按原策略停机；没有沿用旧回执或降低门槛。后续限速安装和独立回执通过；不声称已经证明下载是唯一原因或全天稳定。

## 仍待与未覆盖

- 解锁后的实际本机窗口检查已完成，见 `native-visual.json`。两个客户端启动时实际出现 GNOME 密钥环创建密码提示；本轮只取消，没有创建空密码、降级加密或登录。因未初始化密钥环，普通重开仍可能再次提示；这不能当成客户端缓存丢失。
- 界面遗留：停止的 VM 无法探测安装状态，客户端卡片暂显示“未安装”；启动后会正确显示已安装版本。相关安装按钮停止时不可用，不删除资料，后续应改为“启动后检测”。
- 没有真实账号、登录凭据持久化、真实付费任务测试。GNOME密钥环已安装，首次真正登录可能需要在客体内设置 / 解锁，不用空密码或明文存储代替。
- 当前共享浏览器图形会话；关闭该显示服务会关闭客户端。独立图形生命周期、多桌面管理是另一个需求。
- Cowork / KVM、Computer Use / Dictation、Grok厂商云电脑、摄像头 / 麦克风与第三方扩展不由本轮证明。
- VPS是机房，未购买住宅出口。真实Linux / ARM / VM / 软件图形仍可观察，无法给出防封、实体美国用户或所有网站逐连接出口证明。
- 完整重建清客体整盘和本应用管理副本，不清网站后台、Grok云电脑、本机共享源文件或用户另存的外部备份，不换固定IP，也不是法证擦除。

## 使用路径

打开本机 MuCodeSandbox → 美国 VPS · 全新环境 → 等防护核验 → **桌面应用** → **打开客户端**。本轮保持未登录。

普通关闭重开保留资料。需要全部清空：**设置 → 彻底重建环境 → 确认清除并创建全新环境**。完成后是新ID / 新磁盘，需重新安装客户端。不要用“重置浏览器资料”代替完整环境清理。

技术与对照：[桌面方案](managed-desktop-design-2026-10-12.md)、[竞品详细分析](competitor-desktop-review-2026-10-12.md)、[用户指南](user-guide.md)。

## 本机实拍

![Claude 未登录全屏窗口](../test-results/managed-desktop/claude-native-fullscreen.png)

![Grok 普通关闭后重开](../test-results/managed-desktop/grok-native-reopened.png)

## 后续修正：0.4.11

上述安装状态文案问题已在0.4.11修复并更新本机。当前线路核验再次失败，不能以本报告历史通过状态声明当前仍可联网。详见 [安装状态修正与当前限制](desktop-installation-state-validation-2026-10-12.md)。
