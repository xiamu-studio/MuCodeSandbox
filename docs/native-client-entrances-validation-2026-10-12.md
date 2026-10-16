# 当前环境CLI与桌面入口验证

验证时本机0.4.18 / 52a9b2ef1b71f882，环境“美国VPS · 全新环境”。

- 实际安装Claude Code2.1.296 / Node24.15.0，dev / /home/dev。版本和只读doctor成功；auth status为loggedIn=false，未发现凭据文件，无账号输入 / 模型调用。
- 首次安装因ipify / icanhazip约4.1秒HTTPS超时取消，ipwho回执166.88.36.199；按规则停机并保存逐端证据。重试核验后安装成功，不代表超时根因修复。
- Grok Bot0.68.1未登录窗口已看；Sign in后，官方accounts.x.ai页面实际出现在客体Chrome，本机界面自动切换浏览器页。没有选择 / 提交账号。
- Claude Desktop2.31226.1未登录窗口已看；Get started进入客户端内建空白Sign In表单，不强迫改成外部浏览器，没有填写 / 提交账号。
- 两客户端同时运行时rendererProtected均为true；核验出口166.88.36.199。这不证明Grok云电脑或每条业务连接。

真实OAuth / PKCE完成、令牌保存及登录后功能未验证。材料：`test-results/install-agent-network/installed.json`、`native-client-entrances.json`，同目录failure.json保留首次失败。
