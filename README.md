# MuCodeSandbox

在自己的 Mac 上管理独立 Linux 虚拟机、浏览器和开发终端。
当前源码版本为 **0.4.53 本机测试版**。这是 Apple Silicon Mac 上的本地项目，尚不是已签名、公证的正式发行版。

## 从这里开始

- **[项目总览与交接](PROJECT_OVERVIEW.md)**：路径、设计、文件、现状与待办。
- [源码与文档完整清单](docs/project-files.md)
- [后台使用指南](docs/user-guide.md)
- [当前项目状态](docs/project-status.md)
- [统一待办](docs/TODO.md)
- [全部文档目录](docs/README.md)

项目目录：`/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox`。
安装应用：`/Users/staff/Applications/MuCodeSandbox.app`。
桌面快捷入口：`/Users/staff/Desktop/MuCodeSandbox.app`。
真实 VM / 配置数据：`/Users/staff/.mucodesandbox`。

正常使用直接打开桌面应用，不需要编译或启动源码后台。Mac 显示界面，
浏览器和开发命令在 Linux VM 内执行。官方浏览器不修改内核。
环境配置、浏览器资料及密钥保存在本机数据目录，不随源码上传。

## 当前进展

现有功能包括 Linux 环境管理、独立浏览器及受管桌面应用、开发终端、
手动文件与文字传输、中文输入与DeepSeek中英互译、受限桥接、快照和备份。
浏览器、桌面及终端共用快捷工具；终端粘贴不自动执行。
联网保护要求至少两份独立、有效且与批准出口一致的检测结果，异常时关闭访问。
DeepSeek Key仅在本机加密保存，点击翻译才发送原文，不自动重试或回退直连。
文件面板按需读取列表；不常用的Key设置位于“帮助与更多操作”中。
文件夹导航、时间与文件管理器 **0.4.53 已安装**，Chrome文件夹按钮已实际打开Linux目录，见[交付记录](docs/file-browsing-validation-2026-10-16.md)。
长文翻译与一键取回 **0.4.52 已安装**，支持放大阅读和字号调整；原资料与防护保持，见 [交付记录](docs/long-translation-validation-2026-10-16.md)。此前文件工具交付见 [0.4.51 记录](docs/file-panel-open-validation-2026-10-16.md)，翻译接入见 [0.4.50 记录](docs/deepseek-translation-validation-2026-10-16.md)。
不同历史包的通过结果保留各自版本，不自动当作当前包全面重测。

项目仍未全部完成。正在持续检查 CLI 系统读取与发送；实际已观察到
虚拟化 / 容器探测，且授权命令能够查询并回传 `apple`。不能保证无法
识别虚拟机或不封号。[审计报告](docs/cli-environment-audit-2026-10-11.md)。

当前以现有 Linux 模式的日常可用性与防护稳定性为主。真实账号测试由用户自行操作；
不主动访问 AI 服务或提交内容。原黑屏、偶发网络检测失败等未闭合问题见
[统一待办](docs/TODO.md)。本机模式、GPU 架构变更和正式签名等另行安排，
不为隐藏虚拟化反复修改已够用的字体、语言、时区和资源配置。

## 开发

要求 Node.js ≥24.15.0；全部依赖和命令见 [package.json](package.json)。
开发使用独立数据目录，避免接入正在使用的桌面数据：

```bash
MU_DATA_DIR="$PWD/.mu-data" MU_PORT=4369 npm run dev
```

`npm run build` 构建，`npm test` 运行单元 / API 测试。
VM 专项脚本可能启动环境、下载组件或执行故障测试，先看对应验证文档。
不要把真实数据目录、代理凭据、密钥或私有启动链接公开分享。

整理前的长篇阶段说明保存在 [历史 README](README.history-2026-10-11.md)。
