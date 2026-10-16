# GPU 路线与检测页国旗变化复核

## GPU：可以换路线改善，当前架构不是小改

当前源码：`server/lima-config.ts` 固定 VZ / ARM64 / Ubuntu；`server/guest-display-runtime.ts` 使用 Xtigervnc 软件桌面；浏览器和桌面客户端设置 `GALLIUM_DRIVER=llvmpipe` / `LIBGL_ALWAYS_SOFTWARE=1`，浏览器还关闭加速 Canvas 2D。

软件绘图是 CPU 计算像素，不是页面内容造假。渲染器信息、支持能力与性能可被观察，但不能仅由软件渲染推断真人 / 机器人，也不能由它直接证明会封号。

[Lima 官方 GPU 文档](https://lima-vm.io/docs/config/gpu/) 列出 krunkit；[krunkit 官方说明](https://lima-vm.io/docs/config/vmtype/krunkit/) 将其标为实验性，通过 Mesa Venus 提供 Vulkan。官方示例证明 Vulkan 负载路线，不等同于本项目 Chrome / Electron 桌面已加速。

本机只读前置检查：Apple Silicon / macOS 26.3.1；Lima v2.2.0 中已附带 krunkit 驱动，但 PATH 中没有 krunkit 可执行程序。

| 需要调整 | 当前情况 | 需要的验证 |
| --- | --- | --- |
| VM 后端及依赖 | 当前 VZ；仅有 krunkit 驱动入口 | 独立新 VM、可信安装来源、启动 / 停止 / 恢复 |
| 客体图形驱动 | 当前 Ubuntu 软件渲染；官方非容器示例采用 Fedora 与特定 Mesa | 实际 /dev/dri、Vulkan 和浏览器渲染能力；不能只改 vmType |
| 桌面显示链路 | Xtigervnc 软件 framebuffer | 能用 GPU 的桌面 / 显示服务及受控远程采集，保留清晰度和输入 |
| Chrome 与 Electron | 强制软件路径 | 两种客户端的实际 GPU 工作、稳定性、重开与故障行为 |
| 现有防护与生命周期 | 已绑定现有客体和显示服务 | 重新验证默认拒绝、两份出口回执、租约、文件边界和清理 / 备份 |

**决定：属于较大迁移，本轮不实施。**符合用户“改动特别大也不改”。没有下载大包、编译浏览器 / 内核、迁移生产 VM、把浏览器移到 Mac 或伪造对外设备名。真实 GPU 加速也不能保证隐藏虚拟显卡和虚拟化信息。以前表格的“本路线做不到”应理解为现有 VZ 软件桌面路线的限制，不是所有虚拟机永远无法 GPU 加速。

## 国旗变化：检测页确实先使用中国提示，再查询真实归属

读取了原网站 [检测页](https://ip.net.coffee/claude/) 及 [页面脚本](https://ip.net.coffee/claude/claude-page.js?v=20260916a)，保存原文于 `test-results/country-flag-review/page.html` / `page.js`。

脚本流程：

1. `fetchCNIP()` 从 ip138 / ip.cn 查询 IP，返回值没有国家信息。
2. 页面调用 `renderIPCard('ipAddrCN', 'ipGeoCN', cn?.ip, 'cn')`，把 **cn 写死为初始提示**。
3. `renderIPCard()` 先显示这个中国国旗和收到的 IP，再请求 `/api/geoip/<IP>`。
4. 查询成功后才按 `country_code` 替换国旗。如果归属查询失败，初始提示还可能继续显示。

用原始渲染函数做了控制复现：同一个 `166.88.36.199` 在归属查询完成前显示中国国旗，US 归属结果到达后显示美国国旗，**IP 值没有变化**。材料：`test-results/country-flag-review/reproduction.json`。

这解释了该卡片为何出现先中国后美国；标题“中国出口IPv4”也是站点的固定文案，不是该 IP 归属证明。

随后从 QuickTime 的当前文稿定位到原视频 `/Users/staff/Downloads/20261012-212730.mp4`（33.17秒），使用 macOS AVFoundation 提取最后6秒的24帧。本机没有FFmpeg，未为此安装软件。29.17秒左侧中国国旗 / 右侧美国国旗旁均为166.88.36.199，左侧归属仍在加载；31.17秒三处均显示美国国旗和相同IP。原视频逐帧结果与公开前端流程一致。原始帧与时间记录见 `test-results/country-flag-review/video-frames/` 和 `video-review.json`。

这里的“源码”仅指网站公开发给浏览器的HTML / JavaScript。未取得该站后台代码、评分模型或Claude官方风控代码，不根据前端脚本推测它们的内部规则。

实际客体在 UTC 14:37:52 的三接收端 ipwho / ipify / icanhazip 均回执 `166.88.36.199`，防护 verified；ipwho 返回 United States / Los Angeles。材料：`test-results/protection-events/native.json`。这支持当前探针出口一致，不证明每条业务连接、DNS / WebRTC 的全部路径，也不证明住宅 IP 或“美国 IP 包装”之外所有属性。
