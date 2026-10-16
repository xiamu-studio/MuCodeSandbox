# 官方浏览器安装与中断恢复

2026-10-10，10:01:28.511–10:14:45.689 UTC，源码运行时的真实 Linux VM
专项通过。原报告为 `test-results/browser-install-recovery.json`；独立
原始文件复核为 `test-results/browser-install-evidence.json`，两者
passed=true。没有 Claude 账号、登录或付费模型调用。

## 实现

之前安装器会先删除已有浏览器目录，再解压，安装中断可能丢失可用
二进制。现在先准备 root 控制的旁侧目录，再次校验 SHA-256、解压、
检查版本和权限、同步落盘；保存恢复日志后才切换目录。记录保留旧
安装配方与 AppArmor 策略，提交前失败恢复旧目录和配置，提交后中断
继续清理而不回滚新目录。恢复先于信任已安装配方，并通过锁拒绝并发
安装；异常路径在 bounded recovery 中不沿用已取消信号，恢复失败
明确报错。日志字段、固定路径及 root 权限检查失败时拒绝继续。

当前仍使用官方 Chromium 156.0.8078.4、已批准 SHA-256 和原启动路径，
未修改浏览器内核，未改变 GPU 或 renderer sandbox 设置。安装过程
不修改 `/home/dev/.local/share/mucodesandbox/browser` 的用户资料。

## 实际观察

临时 VM 2 CPU / 2 GiB 内存 / 10 GiB 稀疏磁盘，从独立数据目录启动；
复用已有官方浏览器和网络组件缓存，不下载源码或安装浏览器编译工具。
首次冷安装通过新事务，实际官方浏览器完成一次本地合成登录，然后
全部恢复阶段改为只读测试页面，不再登录。

测试用同一官方压缩包修复已有安装。五处观察点暂停真实 Python
安装进程，核对 `/proc` 的 stopped 状态、可执行文件、root 日志与
提交状态，再 SIGKILL 本轮进程；调用产品恢复脚本，观察：

| 中断点 | 恢复结果 |
| --- | --- |
| candidate prepared | 原目录和旧测试标记保留 |
| old directory backed up | 旧目录恢复到原位置，标记保留 |
| new directory switched | 新暂存安装回滚，旧标记保留 |
| policy / recipe configured | 配置与目录回滚，旧标记保留 |
| journal committed | 新安装保留、旧标记消失，清理完成，不误回滚 |

每个恢复点都核对真实二进制 SHA-256、原 AppArmor 策略、配方和日志
消失，再重新打开实际浏览器。七次浏览器观察包含初始安装、五次
恢复及最终启动；Cookie、localStorage、IndexedDB 全部保留，模拟
登录次数始终为 1。实际画布两色像素正确、日语 / 东京时区 / Linux
平台一致；真实 renderer / GPU 及线程 seccomp、NoNewPrivileges、
能力与命名空间检查通过，网络 active / integrity=verified，防火墙
与转发配置哈希保持一致。

另有注入的解压失败及真实错 SHA-256 拒绝，都在覆盖已有安装前失败，
原二进制和测试标记保留。解压故障注入只用于本轮测试脚本，没有写入
产品安装器或关闭防护。

任务抓包 1,723,927 字节、16,066 个物理外发包，其中批准代理 1,093
个，其余为管理回复 / DHCP，未批准外发 0。独立脚本从原 SLL2 抓包
按 guest interface index 解码，不依赖 Mac 本地接口名称；报告、
实现及测试源文件、画面和抓包哈希均一致，身份与提交 / 回滚状态独立
核对通过。原始证据保存在
`test-results/browser-install-recovery-1791626488500/`。临时 VM、基础
镜像和数据目录全部删除。

## 尚未完成

这是源码的同版本二进制安装修复，没有验证两个不同版本之间的升级，
也不是最新 Electron 包验收。版本目录 / 更新界面、跨版本资料检查点
和回退、更新后完整媒体与性能验收、管理进程取消 / 关闭的全部窗口、
容量故障与整机断电仍需完成。五处安装进程 SIGKILL 不能替代所有
进程、系统故障或真实断电。当前签名安装包 5558c78 未包含此新实现，
它的既有通过记录仍只对应那个包。

设计和剩余要求见
[升级与恢复设计](plans/2026-10-10-browser-upgrade-design.md)。

复验：`npm run test:browser-install-recovery`；独立复核：
`npm run test:browser-install-evidence`。官方浏览器缓存位于
`/tmp/mu-chromium-156.0.8078.4-arm64.zip`，网络组件可通过
`MU_TEST_SING_BOX_CACHE` 指向已有官方压缩包，都会检查 SHA-256。
111 项源码自动测试、TypeScript 与管理应用构建通过。
