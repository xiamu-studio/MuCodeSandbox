# 受保护桌面客户端与彻底重建 Implementation Plan

> For implementation: follow the executing-plans workflow task by task within the user's continuous authorization.

**Goal:** 详细复核竞品，交付 Linux 沙箱内的受管 AI 桌面应用、无账号验收及完整环境重建。

**Architecture:** 桌面应用在现有 Ubuntu ARM64 内以普通 dev 身份运行，复用受认证的沙箱显示通道和默认拒绝网络。安装、启动和查看之前检查现有防护及出口，停止显示会话时关闭客户端。彻底重建创建新 ID / 新磁盘并删除旧磁盘和环境内副本，不迁移客户端目录；普通关闭或切换查看保留资料。

**Tech Stack:** TypeScript / React / Electron 管理器、Lima / Apple VZ、Ubuntu systemd、官方 ARM64 Debian 包、现有 nft / sing-box / 45 秒许可。

## 1. 竞品复核与差距

文件：`docs/competitor-desktop-review-2026-10-12.md`、`test-results/competitor-desktop-review-2026-10-12.json`。
重新核对安装包 SHA、版本、签名，与 186 个静态提取文件绑定；审查 Desktop 模式接口、宿主桥接、浏览器位置和驱动。按确认 / 推断 / 未验分别写明差距，不将 UI 或函数名等同动态安全证明。

## 2. 官方桌面包与运行管理

创建：`shared/guest-desktop.ts`、`server/guest-desktop.ts`、`tests/guest-desktop.test.ts`。
修改：`server/manager.ts`、`server/service.ts`。
固定允许 Grok Bot / Claude Desktop；禁止任意执行路径、下载 URL、Shell 和用户命令参数。官方来源、版本 / 哈希及 Claude apt 公钥指纹校验；安装不登录、不调用模型；不启用 Cowork 的 KVM / 大镜像依赖。
systemd 普通身份、独立客户端资料根、清理代理环境变量、真实地区配置；生命周期绑定显示和环境，先验证防护再开放窗口。
验证来源限制、参数注入、防护失败拒绝、停止 / 重启 / 删除撤销，`node --test tests/guest-desktop.test.ts`。

## 3. 桌面入口

创建：`src/DesktopPanel.tsx`。修改：`src/App.tsx`、`src/api.ts`。
列表展示官方来源、安装 / 运行状态、打开 / 关闭；复用 VNC 显示但明确是 Linux 沙箱桌面。界面不称 Grok 云任务或 Claude Cowork 已受本项目验证。
用隔离数据夹具验证按钮、错误、不同宽度，不调用真实账号。

## 4. 完整环境重建

修改：`server/manager.ts`、`server/runtime.ts`、`src/panels.tsx`、`server/service.ts`、`src/api.ts`。
增加明确的“彻底重建环境”操作和确认文字：旧 VM 全磁盘、客户端缓存 / 凭据 / 本地文件、快照、导入及恢复中间文件都清除。新 ID / 新设备身份、空共享 / 桥接 / 端口，不恢复旧快照。保留选定网络和地区配置。不能删除网站后台记录、用户手动导出的外部备份或本机共享源目录，页面说明边界。
补验删除 `restore/<id>` 等遗留恢复副本及网络上下文清理；失败时不声称删除完成。

## 5. 无账号真实验收

创建：`scripts/verify-managed-desktop.ts`、`scripts/verify-clean-rebuild.ts`。
Grok 已下载官方 0.68.1 / ARM64（99.3MB，安装367MB）；安装 Claude 官方 ARM64。
实际打开客户端、普通关闭重开资料不丢、进程与 renderer 保护检查、客户端网络记录及独立回执一致；主动断开专用代理后访问失败 / 许可关闭，再恢复；使用纯合成数据验证完整重建没有残留。
账号登录、付费模型、Grok 云电脑出口、Cowork / 电脑控制及全天测试不在本轮范围。

## 6. 本机交付与报告

运行适当单元测试、类型检查、UI、包签名 / 模块一致性；更新本机应用。更新项目总览 / 待办 / 使用指南，保存完成报告及未验边界。禁止浏览器源码构建、下载完整新系统或改 Mac 全局网络 / 时区。

## 本轮执行结果（2026-10-12）

上述无账号范围已交付并验收。261 项测试、真实 VM 客户端启动 / 保护 / 持久化、专用线路故障停机及完整重建清理通过；Mac 解锁后的两客户端真实窗口和完整嵌入 / 全屏已核对。详见 [限定完成报告](../managed-desktop-validation-2026-10-12.md)。账号和付费任务未执行；已记录停止环境安装状态文案、独立桌面生命周期及额外平台能力待办。
