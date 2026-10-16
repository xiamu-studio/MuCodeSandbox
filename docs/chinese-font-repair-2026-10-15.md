# 当前沙箱中文字体已修复

后续交付更新：字体安装清单和旧环境补齐逻辑已随 **0.4.48 / 15fef0063284d143** 打包、安装到本机；VM 重启后仍匹配 Noto Sans CJK SC。[本轮交付记录](embedded-viewport-validation-2026-10-15.md)。下文保留最初直接修复 VM 时的验证范围。

2026-10-15，台北时间。当前安装应用仍为 0.4.47 / cc71c27cd93d7f25；本次直接维护现有 VM 的字体，不替换应用包。

## 实际结果

- 修复前 `fc-match sans-serif:lang=zh-cn` 为 Unifont；修复后为 Noto Sans CJK SC，普通和 Bold 均有对应字重。衬线与等宽中文分别匹配 Noto Serif CJK SC / Noto Sans Mono CJK SC。
- 只从当前 Ubuntu 24.04 官方源安装 `fonts-noto-cjk`（`1:20230817+repack1-3`）。apt 模拟和实际结果均是 0 升级、1 新增、0 移除；下载沙箱指定 dev，禁止服务自动重启，未更改网络策略。
- Unifont 保留作缺字兜底，没有删除其他语言字体，没有修改语言、时区或 Mac 字体。
- 原浏览器进程继续缓存旧字形，因此正常关闭、重新打开一次浏览器；未重置资料或清理 Cookie。按现有本地首页配置重新启动，没有恢复真实 AI 网页。
- CUA 实际窗口截图中，本地首页的中文标题和正文已是平滑清晰的字形。仅以该实际结果验收，不把字体匹配命令本身当作已打开浏览器生效的证明。

## 防护与边界

维护前后及重开浏览器后，防护 active、integrity verified、lease active。防火墙、启动规则、转发配置与租约规则摘要均一致；dev 用户无显式应用代理的两个独立 HTTPS 回执（ipify、icanhazip）均为 `166.88.36.199`。仍执行原有两份回执门槛。

没有读取 Cookie 内容或 Mac 剪贴板，没有登录或提交真实账号任务。GUI 核对过程中，电脑操作工具把冒号输成分号，一次自建测试文件路径被浏览器当成 Google 搜索；未发送文件内容，未将搜索结果用于验收。临时标签已随正常浏览器关闭退出，自建 `/home/dev/mu-font-check-20261015.html` 已删除。

证据：`test-results/chinese-font-repair/install.json`、`browser-reopen.json`、`final.json`；原生窗口截图留在本轮电脑操作工具记录中。

## 源码与后续打包

源码已在浏览器依赖清单加入 `fonts-noto-cjk`，共享显示组件也检查旧环境缺包情况；浏览器安装记录命中时也可通过显示组件补齐。**这两处源码尚未重新打包到安装的 0.4.47 中**，应随下一次常规应用更新交付。本次当前 VM 的字体已实际安装，重启该 VM 后保留；不能据此声称旧应用包创建的全新 VM 已含修复。

`npx tsc --noEmit` 通过；`node --test tests/guest-browser-runtime.test.ts tests/guest-display.test.ts` 10 项通过。未重新执行全天、账号或物理故障测试。
