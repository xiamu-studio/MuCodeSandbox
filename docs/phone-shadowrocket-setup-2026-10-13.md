# 手机小火箭接入自有 VPS

日期：2026-10-13。用户已确认小火箭支持SSH，并授权生成手机独立凭据及扫码导入二维码。

## 接入方式

```text
iPhone 小火箭 -> SSH 166.88.36.199:22 -> 美国 VPS -> 网站
Mac 沙箱 -> Mac 本地 SOCKS5 -> 独立 SSH mu-relay 账号 -> 同一 VPS
```

手机直接连VPS，不依赖Mac开机。现有 `127.0.0.1:24898` 只在Mac回环监听，不能直接填到手机。没有新增公网裸SOCKS / HTTP端口，不复用Mac代理私钥或Root密码。

## 凭据和导入

- 手机账号：`mu-phone`，独立32字节随机密码；另留手机专用Ed25519公钥用于维护和验证。
- 账号只允许本地TCP转发，禁止shell / subsystem会话、TTY、远端监听、agent及X11转发，没有sudo。
- 服务器按该账号UID拒绝IPv6出站，避免它和既有固定IPv4出口混用。
- 用户提供的临时测试导出确认为 `ssh://test:test@127.0.0.1:22`。真实二维码使用相同URI格式，不添加猜测的私钥、UDPGW或指纹查询参数。
- 真实密码、私钥、连接URI与PNG均仅保存在本机私有目录，目录0700、凭据0600，不进入项目或聊天正文。二维码本身包含手机连接凭据，属于用户要求交付的私密连接材料。

私有目录：`/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199/mobile-shadowrocket/`。

## 执行入口

用户在本机终端运行 `scripts/setup-phone-ssh.command`；若管理员会话已过期，入口会使用原 `connect-admin.command` 正常请求VPS Root密码。代理不代输Root密码。

`scripts/setup-phone-ssh.mjs`负责生成 / 保留独立凭据、通过已认证SSH会话安装该账号规则、检验实际密码认证并获取两处独立出口回执。原SSH配置会备份到服务器 `/root/mu-phone-setup.*`，配置语法失败时恢复；首次安装失败还会清理新建账号和本次服务。既有Mac `mu-relay` 配置不改。

`scripts/make-private-qr.swift`使用macOS Core Image产生带静区的PNG，并用Vision重新解码，确认内容与输入URI完全相同。没有把凭据上传到二维码网站。

## 当前验证状态

- 用户已执行完整配置入口并确认出现 `MU_PHONE_READY`。本机 `verification.json` 记录于2026-10-13 02:16:15 UTC。
- 服务器手机账号安装完成；实际SSH密码认证通过。有效配置确认只允许本地TCP转发，`MaxSessions 0`，禁用TTY、agent和X11转发，强制nologin。
- 使用手机账号建立临时回环SOCKS监听，分别请求 `https://api.ipify.org` 和 `https://icanhazip.com`，两处均返回 `166.88.36.199`。验证后已关闭临时监听。
- 真实二维码已生成，并由Vision重新解码确认与手机连接URI完全一致；输出不打印密码或URI。
- 脚本Node / zsh语法检查通过；私有目录0700，凭据、私钥和二维码0600。
- 另用手机专用密钥实际请求shell和远端端口监听，均以SSH退出码255拒绝，无超时；没有向手机开放服务器管理能力。
- 配置与限定诊断结束后，临时Root控制连接已正常退出，socket确认不存在；手机账号和现有Mac代理账号不依赖这个管理员连接。
- 实际iPhone扫码导入、Wi-Fi / 蜂窝网连通性尚未验证。

二维码：`/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199/mobile-shadowrocket/ssh-qr.png`。

非秘密核验报告：`/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199/mobile-shadowrocket/verification.json`。

## 手机使用和边界

小火箭首页扫码添加后选择该节点，开启连接，并把全局路由设为代理。仅选节点而仍处于配置 / 规则模式，不代表所有连接都会使用该节点。不需要为这个步骤重写整份分流规则；但DNS和协议支持仍需要另行核对。关闭自动回退 / 自动选最快节点，避免失败后切换到其他出口。

连接后在手机浏览器分别打开 `https://api.ipify.org` 和 `https://icanhazip.com`，确认两处都显示 `166.88.36.199`。这是手机网页连接出口的验证，不是每条手机连接的证明。

当前SSH只配置TCP转发，没有UDP网关。因此不能将全局代理等同于语音、游戏、QUIC、DNS和系统服务的全部流量都已转发成功。手机DNS / IPv6 / VPN断开后的直连路径需要在手机实际核对；不支持的协议具体是阻断还是其他行为，也需结合手机设置确认。

这只统一手机的代理网络出口，不改变手机硬件、操作系统、时区或资料。Mac沙箱的双回执停机规则、Linux防火墙和资料隔离不会自动延伸到iPhone。服务器验证成功也不能替代手机实际验证。

协议参考：[OpenSSH动态TCP转发说明](https://man.openbsd.org/ssh#D)。
