# Code Sandbox 与 MuCodeSandbox：已确认和未确认

复核日期：2026-10-11。对照本机 Code Sandbox 0.5.4 与已安装 MuCodeSandbox 0.4.6 / build63a939051fc7b7ec。未启动对手应用、读取账户资料或进行在线账户测试。

当前主程序 SHA-256 仍为 `c8370bb451ce237f25cc93f1e39977de03148c129a89b4981310f52028636459`，与前次提取校验记录相同。重新读取签名仍为 adhoc、无 TeamIdentifier。原始静态报告位于 `../../artifacts/code-sandbox-analysis-2026-10-09/分析报告.md`，其 `verification.json` 验证 186 个提取文件对应原始二进制片段，不能由此推断运行时防护效果。

| 项目 | 对手的包内证据 | MuCodeSandbox 当前实现 | 可确认程度 |
| --- | --- | --- | --- |
| 开发环境 | Lima 资源、Linux ARM64 guestd、Ubuntu Noble 镜像字符串 | Lima / Apple VZ、Ubuntu ARM64、dev 用户 | 同属 Linux VM 路线；对手实际驱动与客体版本未动态验证 |
| 网络组件 | macOS sing-box、出口与代理模块、Linux nft 相关字符串 | 客体 sing-box 1.14.3 TUN / **system 栈**、默认拒绝规则、短期许可、受控 DNS；限定断线验收已通过 | 旧文档的gVisor表述已纠正；实际安装位置、拓扑、全部故障行为不能认定相同 |
| 浏览器位置 / 发行版 | 内置 macOS ungoogled Chromium **148.0.7778.215-1.1** 镜像、darwin 浏览器管理模块；实际运行 / 更新版本未验 | 浏览器实际运行于 Ubuntu ARM64，Mac接收画面；新空白环境用Google正式稳定155，旧越南资料仍用CfT156 | 有实质区别；包内版本不等于竞品实际运行版本，不能称两者浏览器方案一样 |
| 平台 / 指纹 | 前端有平台、语言、时区、线程、内存及Canvas / Audio / WebGL / WebGPU / Fonts设置，含稳定扰动、固定值等模式 | 保留真实Linux、CPU、软件图形等信息；原生语言/时区、固定桌面及部分上下文已验，未伪造OS / GPU / Canvas | 证明竞品有这些界面和模式，尚不能证明全部底层实现、覆盖和防封效果 |
| 原始 TCP 保留 | 尚无已验证的远端抓包或三层转发证据 | HTTP(S) / SOCKS 连接代理；不提供原始客体 TCP 握手到达目标的保证 | 双方均不能据当前材料声称已解决 |
| CLI / Desktop / 宿主访问 | 教程含CLI隔离、无感和Claude Desktop模式；后两种可调用宿主Shell等 | CLI在Linux；Desktop明确暂缓。按目录/读写/时间授权，仅git-status / git-diff / git-log三项固定本机命令，无任意宿主Shell | 功能范围与授权边界不同，不能互称功能等价 |
| 签名 | 本机包为adhoc、无TeamIdentifier，未见正式NE扩展证据 | 本机包也为adhoc，正式Apple签名/公证及Mac系统级NE未交付 | 不能把竞品这个本机包称为已具备正式Apple开发者签名或经NE防漏验证 |
| 应用 / 浏览器升级 | 前端有stable/beta频道、检查下载、自动安装流程；教程有基础环境回滚说明 | 固定批准版本、手动浏览器升级/资料兼容门禁与恢复；应用/浏览器受信自动升级未交付 | 竞品有静态功能证据，动态安全性未验；我们确有产品化缺口 |
| 备份 / 恢复 | 有重建保留项和基础环境回滚说明；没有同类完整加密导出导入的实验证据 | .mu-backup加密导出导入及限定资料往返已测，第二台Mac/真实账号/断电未验 | 不因为我们有实测就推断竞品缺少该功能，也不能宣称双方恢复保障等价 |

## 为什么当前仍显示 Chrome for Testing

用户截图对应的越南环境仍选择已安装的156.0.8078.4 recipe；当前实际API为
installedChannel=testing、availableVersion=155.0.8059.39、requiresFreshProfile=true。
应用升级到0.4.6不等于已有浏览器资料已经迁到正式版。此前完成的是正式包
接入及空白环境验收，未把旧156资料交给155打开；这不是截图缓存或标题没刷新。

要去掉这个提示，应真正使用正式浏览器和兼容资料。现有可用路径是另建
空白环境，保留原越南资料；当前还没有保留旧资料的一键新资料切换入口。
不能直接清掉版本记录、覆盖旧目录或隐藏提示，把156当成正式消费者发行版。
旧资料迁移和删除应作为明确操作安排，不由“为什么还有提示”自动执行。

## 当前复核证据

- 本机竞品主程序SHA仍为c8370bb451ce237f25cc93f1e39977de03148c129a89b4981310f52028636459，CDHash836f77b678ae3a9b826a1583d6d60890f2f6db62，与原提取验证一致。
- 指纹UI：`../../artifacts/code-sandbox-analysis-2026-10-09/extracted/frontend/dist/assets/browser-profile-editor-DCfVqu6B.js`。
- 更新UI：同目录`app-update-manager-bVey8wkv.js`；这些是压缩前端静态证据。
- 我们的实际交付及资料保留：[六项验收](normal-linux-validation-2026-10-11.md)、`../test-results/normal-linux/installed.json`。
- 当前TUN栈：`../server/transparent-network.ts`；固定宿主命令：`../shared/types.ts`与`../server/host-bridge.ts`。

Linux 浏览器通过连接代理时，网站的页面层可能看到 Linux，但远端 TCP 层来自最后建连的代理端或网络栈。代理也运行 Linux并不能证明所有握手参数相同。反过来，Mac 浏览器经 Linux 代理也不等于一定被平台封禁。

目前只能确认“部分基础架构相似、浏览器位置不同、全链路一致性尚未证实”。确认实际效果需要在同一条获准线路、同一个无账号接收端，分别记录页面平台 / Worker / 请求头、TLS ClientHello 与 TCP SYN，并做直连正向对照。上游若改变、重建连接或使用用户态网络栈，要按真实接收结果解释。防火墙无泄漏、固定出口、特征一致和账号是否封禁是四个不同结论。

相关材料：[帖子对照](network-posts-comparison.md)、[剩余验收](gaps-and-validation.md)、[Cloudflare 关于 CONNECT 的说明](https://blog.cloudflare.com/a-primer-on-proxies/)、[Claude Code 官方支持的平台](https://code.claude.com/docs/en/setup#system-requirements)。
