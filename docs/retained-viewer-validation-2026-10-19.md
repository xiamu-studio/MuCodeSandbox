# 切换 tab 不再重复连接画面

2026-10-19，**0.4.54 / 76dc77e8cbfcb0a9 已安装并恢复原沙箱**。用户确认保存工作并结束传输后正常更新；安装后的本机核验见文末。

## 原因

0.4.53的GuestBrowserView连接effect依赖active。隐藏tab时会移除画布并断开RFB WebSocket；回来时重新获取一次性票据、重新握手，因此显示“连接中”。Linux中的浏览器和桌面应用通常仍在运行，这个分支没有刷新网页或重启客户端。设计原意是避免后台重复解码高清画面。

## 改动

- 同一环境内首次访问才连接；正常切换保留认证连接、解码器和画布，回来直接恢复，不重新取票或显示连接遮罩。
- 隐藏时通过RFB协议暂停增量请求/连续更新，保留有限的在途消息正常处理，不丢弃协议字节或积压无限缓冲。恢复时请求新画面；解码器状态和当前画面保留。
- 隐藏画面设为viewOnly、关闭点击聚焦，隐藏声音停止；原有快捷工具仍按active限制读取/输入和传输队列。环境切换/关闭会清理旧连接，真实断线保持提示，手动重连仍使用新票据。
- 桌面应用状态偶发读取失败时保留已有画面并显示错误，恢复读取后继续更新；不会仅因状态接口失败销毁画布。浏览器版本信息在返回时保留显示并重新读取，减少空白闪烁。
- 没有更改联网保护、票据校验、定时授权/撤销或Linux软件/字体/资源。与已安装0.4.53相比，65个服务端模块逐字节一致；版本共享常量单独更新。

## 实现与验证

noVNC固定1.7.0的本地构建转换增加updatesPaused。仅改变完整RFB消息边界的画面请求调度，不改变认证、编解码或剪贴板；上游锚点变化时构建失败，避免静默忽略暂停。MPL说明及修改后的对应rfb.js源码包含在安装包desktop/third-party-source中。

- `scripts/verify-retained-viewer-ui.ts`：生产组件+真正的修改后noVNC，连接本地合成RFB服务。普通请求和连续更新两种模式各反复切换10轮，隐藏画面停止更新；两种tab只在首次各取一次票据，返回无连接遮罩，画布对象不变。切换环境关闭原连接，新环境隐藏时不连接；真实断线显示提示，手动重连取得新票据。无页面/控制台错误。
- `scripts/verify-fixed-display-ui.ts`：真实本地RFB握手，固定尺寸/2倍密度、全屏/小窗口、右下输入坐标、手动重连与自适应回归通过；保留页断言改为连接和画布保留。
- `scripts/verify-retained-panel-polling.ts`：隐藏页不重复状态检测、返回即时刷新、慢请求不重叠、隐藏任务切换不读UI状态，通过。
- `scripts/verify-all-quick-tools.ts`：四入口快捷工具回归通过，补充桌面状态503错误与恢复不重建画布。所有输入/译文均为合成内容。
- 固定noVNC源码变换与上游漂移拒绝检查、TypeScript、生产构建通过。候选安装包另经正常包检查。

证据：test-results/retained-viewer/、fixed-display/、all-quick-tools/及retained-panel-polling报告。没有访问真实AI站点、操作账户或读取用户页面正文。以上为本地组件/协议/包验证，尚未代替更新后的本机窗口验收。

安装包核对通过：严格签名、依赖加载、本地合成服务、加密备份回环和篡改拒绝；不是Apple公证或生产VM备份验收。源码与本地应用暂未替换，候选包为release/retained-viewer-0454/mac-arm64/MuCodeSandbox.app。

## Installed verification (2026-10-19)

The candidate-stage statements above describe checks before replacement. The user confirmed saved work and completed transfers. Normal VM stop and native menu quit succeeded. The staged bundle passed strict signature/version checks, then replaced ~/Applications/MuCodeSandbox.app. The old app is retained at ~/Applications/.MuCodeSandbox-before-0.4.54.app.

API and native UI confirm 0.4.54 / 76dc77e8. VM start and browser-open jobs succeeded. The browser opened only its configured local homepage; no real AI pages or desktop AI clients were opened. Resource/identity/network/share/port configuration matches the baseline. Key metadata/configured status and workspace/browser/client root directory identities and permissions match.

Protection is active/verified with a valid lease and hashes matching current approved markers. Ordinary guest HTTPS checks at ipify and icanhazip both returned 166.88.36.199.

Native UI verification switched browser to desktop-app tab and back. The same guest VNC TCP peer and inode existed while visible, hidden and returned; the returned UI immediately showed connected with no connecting label. Actual AI desktop clients remained closed; the two-live-viewer case uses the synthetic real-RFB evidence above. The app is left on its browser tab.

Evidence: test-results/retained-viewer/{before,installed,sockets-visible,sockets-hidden,sockets-returned,native-ui}.json. No clipboard reads, paid model requests or GitHub upload in this installation turn.
