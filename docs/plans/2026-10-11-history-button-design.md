# 检测历史按钮样式调整

用户要求：日志页的“查看检测历史”按钮与应用风格一致。

采用现有 `Button` 次级按钮组件，沿用圆角、细边框、悬停和键盘焦点样式；
按钮内含历史图标、操作文案、独立回执数量标签及展开箭头。展开后文案
改为“收起检测历史”，箭头朝上，保留 `aria-expanded`。

只修改 `src/NetworkActivity.tsx` 和对应样式，不调整采集、出口策略或历史数据。
构建后更新现有本机应用，实际验证展开 / 收起并保存截图；此低影响样式
调整不增加镜像、浏览器下载或新的单元测试。

## 本机交付结果

已安装 0.4.5 样式修订构建 `7c2737978926f345` 到
`~/Applications/MuCodeSandbox.app`。TypeScript / 前端 / 服务端构建通过，
候选和安装副本深度严格签名检查通过。桌面日志页实际点击确认数量标签、
圆角边框、展开 / 收起文案、箭头及历史表格切换；原网络配置保留。
证据：`test-results/native-history-button-collapsed.png`、
`test-results/native-history-button-expanded.png`、`test-results/history-button-build.log`、
`test-results/history-button-package.log`。本轮未重跑全部网络或长期验收。
