# 0.4.16 环境名称旁的延迟与客户端出口复查

本机 `/Users/staff/Applications/MuCodeSandbox.app` 已更新到 0.4.16 / build `c3a052fd19636401` / CDHash `bbaa5254ab2951a602f448a4997c3f153bbf4794`。

## 界面

延迟从防护条移到环境名称右侧，主值22px，保留“测延迟”和悬停测试时间说明。窄窗口与长名称自动换行。网络页明细和旧检测口径不变：三轮复用连接请求往返的中位数，失败 / 停机不显示旧成功值或伪造0ms。

272项测试通过；1320 / 800 / 390px 隔离界面验证通过，宽窗口标题和延迟垂直中心差0px、间隔18px。实际本机按钮检测 Google，三轮317 / 615 / 198ms，中位317ms，3/3成功。当前防护 active / integrity verified / leaseActive。

## 客户端出口

Grok 与 Claude 桌面客户端受管 unit 均配置为 Linux `dev` 用户；更新前运行中的 Grok 实际 UID=502，与dev一致。使用相同普通用户、空白环境变量、不设置应用代理的 HTTPS 请求，ipify / icanhazip 两端在更新前后均回执166.88.36.199；批准出口检查也为美国 / 166.88.36.199，防火墙与透明代理配置哈希保持一致。

这验证当前共用路由与普通用户出口，不是每条客户端连接的独立远端来源证明。服务商云端执行任务的出口不由本机沙箱控制。真实账号及付费任务未参与。

## 本轮观察到的限制

更新前曾再次发生“独立出口回执不足”，环境按原规则停止；更新退出也正常撤销许可。新版已从本机启动成功并重新核验相同出口，未降低安全门槛。一次成功核验不是长期稳定性验收，既有回执偶发不足问题继续保留待办。

## 原始材料

- `test-results/headline-latency/ui.json` / `unit.log` / `package.json`。
- `egress-before-update.json` / `egress-current.json`：当前路由、客体身份和两个外部回执，后者为0.4.16。
- `native.json` / `native-current.png`：真实本机标题位置和手动延迟检测结果。
- 方案：[环境标题旁显示延迟](plans/2026-10-12-headline-latency-design.md)。
