# 本机沙箱浏览器清晰度验证

日期：2026-10-11。安装版 **0.4.5**，构建 `108711125db2b9d2`。
安装路径：`~/Applications/MuCodeSandbox.app`，桌面快捷入口沿用。
本轮仅修正显示分辨率与原生密度，不恢复其他暂缓工作。

## 问题与改动

旧实现固定使用 1280×800 客体桌面，查看窗口只把画面拉大。
Retina / 全屏因此缺少实际像素。新实现读取当前查看区域尺寸和宿主
`devicePixelRatio`，通过已认证的 RFB SetDesktopSize 调整客体桌面，
并通过 `xsettingsd` 调整原生 DPI，让浏览器文字保持正常显示尺寸。
官方浏览器未修改；不使用页面设备仿真、不改变 Mac 屏幕或时区设置。

查看区域 resize、全屏 / 退出全屏、焦点和像素密度变化会触发适配。
同一 VM 有多个查看窗口时，以当前有焦点的窗口为准。请求去抖并串行，
尺寸与密度严格校验。只有实际 RFB 回执、原生浏览器密度都匹配后才显示
匹配结果；失败会提示，保留认证和防护，不静默关闭限制。

客体新增 Ubuntu 官方仓库的 `tigervnc-standalone-server` 和 `xsettingsd`，
本次下载约 11.2 MB，安装增量约 55.8 MB；不下载浏览器源码或编译工具链。
VNC / CDP 仍仅客体回环地址，通过现有私有 SSH 通道访问；VNC 保留密码
认证，剪贴板双向传递仍禁用。显示设置更新只向经路径、属主和 service
归属检查的 xsettingsd 发送信号。

## 安装后的实际结果

这台 Mac 内置屏实际像素 2940×1912，逻辑尺寸 1470×956，密度 2×。
沙箱画面按可用区域分配像素；标题栏与工具栏占用空间，画面高度无需等于
整块屏幕高度。以下均来自同一已安装构建、同一越南 VM 的桌面实际操作。

| 状态 | 查看区域逻辑尺寸 | 客体实际像素 | 浏览器原生密度 | 结果 |
| --- | --- | --- | --- | --- |
| 普通内嵌窗口 | 988×618 | 1976×1236 | 2× | 匹配 |
| 全屏 | 1470×875 | 2940×1750 | 2× | 匹配 |
| 退出全屏 | 988×618 | 1976×1236 | 2× | 匹配 |

最终包首次打开浏览器直接连接成功，无需手动重新连接。修正就绪检查
顺序：先等待浏览器调试接口就绪，再检查 VNC，避免反复提前探测触发
VNC 连接限制；没有取消认证或关闭原有黑名单保护。

源码测试 176 项通过；TypeScript、前端及服务端构建通过；候选与安装
副本的深度严格签名检查通过。签名仍为本机临时签名，未做 Apple 公证。
启动后防护横幅已核验，浏览器首页显示越南出口 160.191.52.242。
本轮没有登录 Claude，不把 IP 首页回执当作全部网络防泄漏证明。

## 证据与复核入口

- 原生桌面截图：`test-results/native-retina-normal.png`、
  `test-results/native-retina-fullscreen.png`、`test-results/native-retina-exited-fullscreen.png`。
- 实际服务回执：`test-results/retina-normal.json`、
  `test-results/retina-fullscreen.json`、`test-results/retina-exited-fullscreen.json`。
- 测试 / 构建 / 打包：`test-results/retina-display-unit-final.log`、
  `test-results/retina-display-build-final.log`、`test-results/retina-display-package-final.log`。
- 客体组件安装：`test-results/display-components-install.log`。
- 独立组件尺寸回执：`test-results/display-component-probe.json`。
- 只读检查：`node scripts/inspect-retina-delivery.ts <label> <环境 UUID>`。

## 验证边界与待办

当前限制单边最多 8192 像素，总画面最多 1600 万像素，密度 1–4×。
超大区域会限制像素，并提示未完全匹配，不承诺任意屏幕无限分辨率。
已完成这台 Mac 的普通 / 全屏 / 回切；外接屏跨密度移动、多屏、
非整数密度和超限区域仍待实机验收。更高分辨率会增加客体绘图、传输
及内存开销，本轮没有做全天性能测试。

设计与实现位置见 [Retina 设计](plans/2026-10-11-retina-display-design.md)。
其余工作维持 [统一待办](TODO.md) 的安排。
