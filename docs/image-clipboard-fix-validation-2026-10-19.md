# 图片剪贴板 Electron 44 接口修复

用户在0.4.55实际点击后遇到`clipboard.readImage is not a function`。这是主进程接口兼容错误，发生在传入Linux前，不是出口IP或联网防护故障。原先单测模拟了旧readImage接口，未覆盖当前Electron接口；原有合成Linux读回及界面测试不能证明这个Mac入口可用。

**0.4.56 / 44b376c48fe16394 已安装并恢复原沙箱**。用户先选择暂不重开，随后明确“现在重开吧”；据此完成正常退出、分阶段替换和恢复。

## 修复

- 按本地Electron44.7.0类型定义及[官方接口](https://www.electronjs.org/docs/latest/api/clipboard)改用异步`clipboard.read()`，只对图片项目调用`getType('image/png')`，不读取文字、HTML或文件路径载荷。
- 每次异步等待后重新检查可信主框架。保留用户手势、10MiB/1600万像素限制；在NativeImage解码前先检查PNG头部和尺寸，再规范为PNG。
- 界面只显示已知中文错误；未知IPC异常改为中文读取失败提示，不再暴露整段英文TypeError。不自动重试或回退读取文字/路径。
- `tsconfig.desktop.json`检查这个CJS桥接对Electron真实类型的调用，纳入每次`npm run build`；旧readImage调用无法再通过构建。
- 67个服务端模块与已安装0.4.55逐字节相同，包括授权、图片传输、Linux剪贴板程序及网络防护；不改原数据、字体、网络或资源配置。

## 验证范围

- 新增真实运行时检查`scripts/verify-image-clipboard-runtime.ts`：Electron44.7.0报告read为function、readImage为undefined；使用实际ClipboardItem和NativeImage类处理合成PNG，解码像素逐字节一致。仅检查全局clipboard方法类型，不读取、枚举、写入或清空用户系统剪贴板；输入来自测试自建ClipboardItem。
- 5项PNG/API/主进程异步图片及授权测试通过。覆盖非图片不getType、等待读取后来源失效不继续、超限和损坏数据不解码、只读取image/png、传输不写命令参数等。
- 生产界面组件合成测试通过：按钮/⌘V路径、断线/隐藏期间作废、已知IPC错误转中文与未知TypeError安全提示、无重试、CLI不写PTY、小屏不溢出。
- TypeScript（含新桌面桥接检查）与生产构建通过。候选包严格签名、依赖加载、合成服务、加密备份回环、篡改拒绝检查通过；是本地ad-hoc签名，不代表Apple公证或真实VM备份。候选包内实际桥接文件也由Electron44.7.0的真实ClipboardItem/NativeImage合成检查通过。实际系统剪贴板和目标网站粘贴由用户点击验证，不把这些合成检查表述为已经读取用户真实图片。

候选：`release/image-clipboard-fix-0456/mac-arm64/MuCodeSandbox.app`。证据：`test-results/image-clipboard/runtime.json`、`ui.json`及`test-results/image-clipboard-fix/core.json`；本轮未主动访问AI服务、启动AI客户端或调用真实翻译。

## 安装核验

已安装`~/Applications/MuCodeSandbox.app`，严格签名及0.4.56 / 44b376c48fe16394核对通过；旧版保留在`~/Applications/.MuCodeSandbox-before-0.4.56.app`。正常停止、启动环境与打开配置的本地首页任务成功。

实际窗口及API均确认新版。资源、身份、网络、共享目录和端口配置与更新前一致；Key仅核对元数据及configured状态，不读取或解密。workspace、浏览器/Default、两个桌面客户端和CLI资料根目录的inode/权限保持。

防护active、integrity=verified、leaseActive=true，各项实际保护hash与安全标记一致。普通guest通过ipify、icanhazip两处HTTPS检测均为166.88.36.199。安装后的实际桥接文件再次经Electron44.7.0真实类合成PNG像素回环通过，没有访问用户系统剪贴板。本机工具面板已打开并显示可用的图片按钮；真实图片由用户点击使用，没有代理读取或上传。安装前后证据位于`test-results/image-clipboard-fix/before.json`和`installed.json`。
