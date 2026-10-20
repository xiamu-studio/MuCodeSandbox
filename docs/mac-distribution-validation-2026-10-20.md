# 其他Mac测试安装包：0.4.65

2026-10-20：已生成`release/distribution/0.4.65/MuCodeSandbox-0.4.65-mac-arm64.dmg`，build 05a784635cbd294e。当前本机安装仍为0.4.64，未停止、替换或重开正式使用中的应用和VM。

## 内容与兼容

DMG包含MuCodeSandbox.app、Applications快捷入口和安装说明，打开后可拖入应用程序。仅Apple Silicon；Electron、宿主命令桥接及网络监测组件构建目标均为macOS 13.0。当前只在macOS 26.3.1开发机验证；没有第二台Mac及macOS 13/14/15实机证据，构建目标不能代替该范围验收。

原生Swift编译原本没有部署目标，两个辅助组件随开发机被标记为最低macOS 26.0。本次显式传入目标13.0，Swift源文件和防护逻辑不改；包内macOS Mach-O的已记录最低版本均不高于13，非macOS平台预编译文件不作为可执行目标。

应用帮助原来直接打包内部使用指南、技术记录和TODO，其中有本机用户路径、个人出口IP和旧安装信息。现改为独立的通用帮助资料，内部工程文档保留在仓库，界面提供上手、通用指南、技术边界和支持范围。安装说明不包含个人配置，其他Mac首次使用自行设置网络与Key。

## 验证

- 构建与ARM64 app打包、TypeScript检查通过。
- `verify-package.ts`：包依赖、合成协议/备份、严格临时签名及篡改阳性对照通过。
- 包内实际辅助组件执行`tests/bridge.test.ts`与`tests/host-commands.test.ts`，10项通过；覆盖路径/链接、只读、能力、Git命令和进程退出边界，不启动实际用户VM。
- `verify-host-network-native.ts`：12项合成网络指纹检查、真实Mac订阅和心跳通过；未修改物理网络。
- `verify-mac-distribution.ts`：包内无运行数据库、凭据文件、Key配置、SSH私钥、VM备份；自有前后端/桌面静态资产无个人出口IP、专用端口、本机路径、环境ID或Key形态字符串。82个后台/桌面JS模块与安装0.4.64逐字节一致，仅版本常量不同。
- 同一验证使用包内Electron运行编译服务，创建独立临时0700数据目录，首次启动0个环境、翻译Key未配置、首页HTTP200、网络监测正常启动，结束后移除测试资料。它证明空资料启动服务，不冒充另一台Mac的完整GUI与VM安装流程。
- `create-mac-dmg.ts`：生成压缩只读镜像，hdiutil完整校验；只读挂载后验证app严格签名、build与说明一致，再卸载。输出SHA-256文件；公开安装包信息仅记录文件名，不包含本机绝对路径。

证据位于`test-results/mac-distribution/`、`test-results/package-integrity.json`、`test-results/host-network-native.json`；分发目录附有`安装说明.txt`、`安装包信息.json`和`.dmg.sha256`。

## 签名与分发范围

本包仍是ad-hoc临时签名，未有Developer ID和Apple公证，不能保证在另一台Mac上通过默认Gatekeeper。DMG压缩封装不改变此状态。正式面向用户分发，需要对应Developer ID签名、公证和更新流程；不以关闭系统安全保护作为交付方案。

Apple官方说明：https://developer.apple.com/developer-id/
