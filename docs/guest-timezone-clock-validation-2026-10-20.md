# 沙箱时区时钟：0.4.64

2026-10-20：0.4.64 / de1738f889cde2d0已安装并重开，原沙箱恢复运行。

## 显示与数据

在查看器环境名称、Linux标记旁显示日期、双语星期、24小时制时间和时区缩写，例如`10/20 星期二 Tuesday 05:34:56 PDT`。标题区域较窄时显示`周二 Tue`，窄窗口省略月日但保留星期与时分秒；悬停始终显示完整日期、双语星期、IANA时区和当前UTC偏移。

按现有环境`identity.timezone`换算本机当前时刻，自动遵循夏令时。它是时区显示，不是读取VM系统时间或验证两台系统时钟已校准；tooltip说明时间来源。不修改主机或VM时区，不新增网页、SSH或网络检测。

浏览器与桌面嵌入查看器直接传入已有环境配置；独立窗口复用既有名称元数据读取，重连时重新读取，并按环境ID隔离，等待或无效时区不回退到Mac时区。每秒只更新时钟组件，后台标签/页面不可见时暂停，恢复时立即刷新。

## 本地验证

- `scripts/verify-guest-timezone-clock-ui.ts`：生产查看器和时钟组件、自有本地HTTP端点和合成时刻。已核对配置时区、中英文星期、洛杉矶跨日、春季跳时与秋季回拨及PST/PDT、切换东京、未知/无效时区、秒级更新不增加API/票据或替换画布、隐藏/停用暂停与恢复、1600/1100/700/390px布局，以及独立窗口复用元数据、显式重连更新以及环境切换不显示旧时区。9组通过。
- `scripts/verify-fixed-display-ui.ts`：固定桌面尺寸、窄屏/全屏和指针边界通过。
- `scripts/verify-retained-viewer-ui.ts`：普通与连续帧两种模式，完整帧恢复、焦点合并、手动/尺寸重绘、隐藏停帧和10次切换保留连接通过。
- 候选验证没有访问AI网站、真实账号或真实翻译；安装在用户确认保存工作及传输结束后执行。

证据：`test-results/guest-timezone-clock/ui.json`及宽/窄截图；显示/保留连接回归分别在`test-results/fixed-display/ui.json`、`test-results/retained-viewer/ui.json`。

构建和ARM64候选包已完成。与安装0.4.63逐字节比对，82个后台/桌面JS模块一致，仅版本常量更新；noVNC扩展源码也一致。没有改动防护、代理、出口核验、系统时区或VM资源配置。

`npm run package:mac`类型、原生构建、前后端与ARM64打包通过；`scripts/verify-package.ts`本地包依赖、合成协议、严格签名和篡改阳性对照通过。安装包为本地ad-hoc测试版，不是Apple公证发行版。

四入口快捷工具回归`verify-all-quick-tools.ts`通过，浏览器和桌面查看器均显示环境时区，终端仍保留原有工具。候选完整证据汇总在`test-results/guest-timezone-clock/delivery.json`。

## 安装与实际窗口核对

用户确认后，正常停止原环境、退出0.4.63，分阶段复制并严格核对签名后安装0.4.64。旧包保留在`/Users/staff/Applications/.MuCodeSandbox-before-0.4.64.app`。本机服务与原生窗口版本/build一致，VM启动任务、本地首页恢复任务均成功。

原配置投影、翻译Key文件元数据和配置状态、原浏览器/桌面/CLI资料根目录身份均保持。实际防护active、integrity verified、leaseActive为true，防火墙/引导/隧道/租约哈希与安全标记一致；两处普通沙箱HTTPS检测出口均166.88.36.199。

只在本地`/opt/mucodesandbox/browser-home.html`核对，原生画面已连接。标题旁实际显示`10/19 周一 Mon 23:49:51 PDT`，悬停完整时间为`America/Los_Angeles · 2026年10月19日星期一 GMT-07:00 23:49:51 · Monday`；前次观察23:49:11、后次23:49:51，确认持续刷新。该日期按洛杉矶时区换算，主机台北日期为10/20。没有更改主机或VM时区，也未访问AI站点或请求真实翻译。

安装前后与原生核对证据：`test-results/guest-timezone-clock/before.json`、`installed.json`、`native-smoke.json`和`delivery.json`。
