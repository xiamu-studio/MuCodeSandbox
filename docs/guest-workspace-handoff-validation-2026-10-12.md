# 0.4.17 并行工作区、客户端衔接与手动传输

2026-10-12，台北时间。只做无账号验证，不登录真实账户，不调用付费模型。

## 已取得证据

- 284项单元 / API 检查全部通过：守护失效拒绝访问、客户端并行、URI 白名单、队列隐私和期限、重复 MIME 项规范化、文件路径及链接边界、文本大小和访问撤销。
- 临时界面使用模拟 RFB / 终端：浏览器与桌面六次切换保持2个画面实例、0次关闭；shell与CLI维持2个连接。手动文字发送、取回、文件上传和下载通过，没有后台读取剪贴板。
- 安装构建 `95c4a6b749b1286c` 实际 VM：显示、Chrome、Grok和Claude Desktop同时active；两客户端renderer保护通过；六次焦点切换保持PID；单独关闭Chrome不关闭客户端。
- 实际默认 `xdg-open` 启动受管Chrome，本地接收器收到假授权码、假state、浏览器Cookie和客体loopback来源；固定 `claude://` 普通动作回到相同资料的已运行Claude客户端，PID不变。未向厂家提交假授权码。
- 实际文件上传 / 列出 / 下载：79字节含中文及二进制零字节，SHA256逐字节一致，随后只删除这一个独特命名的测试文件。实际中文剪贴板往返通过，未读取 Mac 剪贴板。
- 两客户端实际启动参数均为 `--password-store=basic`。`fc-list` 无WenQuanYi；中文字体回退为Unifont。移除的包只有 `fonts-wqy-zenhei`，没有删除 Mac 字体。
- 本次结束核验：防护active、integrity verified、有效租约，批准出口166.88.36.199。

## 修正与边界

队列读取的Python非raw正则曾发出SyntaxWarning，混在JSON输出中导致链接没有处理，已改raw正则。客户端注册关联产生重复 MIME 项，现接受并规范化重复项，保留其他文件关联。主窗口接入上下文隔离的preload，客体网页 / 客户端返回通知可选择对应页面；IPC没有增加任意宿主命令接口。

用户明确不用密码保险箱，采用basic后端，不提供安全的钥匙环凭据加密；没有解密 / 迁移未知旧凭据，也未清空资料。[Electron说明](https://www.electronjs.org/docs/latest/api/safe-storage)。

构建95c4a6b的探针HTTP限时8秒、连接4秒，Lima外层预算20秒。真实Grok登录入口随后再次触发回执不足，仍被正确隔离。后续诊断将HTTP预算设12秒、命令整体24秒，仍小于45秒内核租约；变化IP立即拒绝，失败端名字进入错误提示。旧错误保留为 `actual-before-command-budget.json`。不能以一次恢复证明长期稳定性，两个独立一致回执、TLS和停机规则保留。

本地假回调不能证明真实厂商账号的OAuth校验、PKCE、登录完成和令牌持久化。实际CLI未登录付费任务、24小时长期测试、正式Apple签名仍不是本轮验收。Grok云电脑出口不受客体本地网络规则控制。

## 使用方式

在浏览器或桌面画面工具栏点“文件与粘贴”。Mac文件选择或拖入后进入 `/home/dev/Transfers/Incoming`；沙箱导出文件保存到 Downloads 或 Transfers/Outgoing，再在面板刷新下载。单文件25 MiB，拒绝目录跳转、符号 / 硬链接和特殊文件。没有新开任何Mac共享目录。

文字先在面板粘贴，再手动发送；沙箱内Ctrl+V。反向在沙箱Ctrl+C、主动取回、核对、复制到Mac。只支持64 KiB普通文本，不自动同步。关闭面板清空宿主预览；客体选择服务随显示关闭并清理临时文件。

## 材料

- `test-results/guest-workspace-handoff/unit.log`
- `test-results/guest-workspace-handoff/ui.json`、`ui-file-transfer.png`
- `test-results/guest-workspace-handoff/actual.json`
- `test-results/guest-workspace-handoff/exchange-actual.json`
- `test-results/guest-workspace-handoff/package.json`
- 最终本机图形检查与构建身份将另存 `native-final.json`。

[设计](plans/2026-10-12-guest-workspace-handoff.md)、[使用指南](user-guide.md)、[统一待办](TODO.md)。
