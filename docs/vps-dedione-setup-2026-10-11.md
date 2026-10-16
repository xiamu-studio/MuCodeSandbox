# DediOne VPS 专用出口接入

2026-10-13补充：现有中继已启用标准SSH错误的系统时间戳，并增加只读诊断入口；10:45真实三端超时及正常恢复均保留，根因仍未知。操作与材料见[中继诊断与恢复](vps-relay-diagnostics-2026-10-13.md)。以下是首次接入及前序验收，按各自时点理解。

最新交付（2026-10-12）：本机已安装 0.4.8、build `68f265115b8a4c74`，修正单 IPwho 查询超时引起的误停。真实十分钟 77 轮多接收端核验、断线隔离 / 恢复、错误批准 IP 拒绝与实际普通 / 全屏画面通过。[最新限定验收](vps-goal-validation-2026-10-12.md)。下面保留首次 0.4.7 部署事实，不把当时九分钟成功覆盖后续失败。

更新日期：2026-10-11（台北时间）。这次接入的是美国机房 VPS，没有住宅代理。

## 实际架构

```text
全新 Linux 沙箱 → 客体受控 DNS / TUN / 防火墙
             → Mac 回环 SOCKS5 127.0.0.1:24898
             → SSH 加密连接（物理 Wi-Fi en0）
             → VPS 166.88.36.199 → 网站
```

- VPS：DediOne 洛杉矶，AlmaLinux 8.9 x86_64；已有 OpenSSH 8.0。
- 服务器新增 `mu-relay` 专用账号，只有公钥认证、本地 TCP 转发权限；不能执行 shell、不能创建远端监听、没有 sudo。
- SSH 是本次代理实现；没有在公网开放 HTTP / SOCKS5 代理端口。
- VPS 官方 BaseOS 安装 `iptables` 及依赖，软件包下载约 1.4 MB、安装增量约 3.8 MB。
- VPS `mucodesandbox-relay-network.service` 只阻止 `mu-relay` 的 IPv6 出站，已设置开机启用；不移除 VPS 分配的 IPv6 地址。
- 首次测试确实发现同一 SOCKS5 入口向不同接收端使用 IPv4 / IPv6。加账号级规则后，三个接收端返回同一 IPv4。
- Mac SSH 服务通过系统自带 `nc -b en0` 绑定 Wi-Fi，避免这一条 SSH 连接经过现有 Clash TUN。没有修改 Clash 订阅、规则、模式或系统路由。
- 绑定 en0 是本机配置：Wi-Fi 不可用或换用其他接口时，连接会失败，不能把当前配置称为已完成跨网络适配。

## 全新环境与资料边界

用户明确要求换 VPS 服务时**完全新建环境**，而非复用旧浏览器资料。

| 内容 | 实际值 |
| --- | --- |
| 新环境 | 美国 VPS · 全新环境 |
| 新环境 ID | `76c193f7-09a2-4544-83b8-4852445ab2be` |
| 新 VM | `mu-76c193f709a24544` |
| 资源 | 4 CPU / 4 GiB / 30 GiB 逻辑磁盘 |
| 线路 | SOCKS5 `127.0.0.1:24898`，严格防护与透明代理开启 |
| 出口锁定 | `166.88.36.199` |
| 地区配置 | `en-US` / `America/Los_Angeles` |
| 旧环境 | 美国 · 原线路；已恢复原 B1013 配置并停止 |

新 VM 从无账号的受保护基础镜像创建；没有克隆旧用户 VM、导入旧快照、复制浏览器资料或 CLI 配置。首次打开浏览器前，实际检查 `/home/dev/.local/share/mucodesandbox/browser`、`/home/dev/.claude.json`、`/home/dev/.claude` 均不存在。新 VM 内没有项目共享目录或宿主命令授权。

同一个新环境以后正常关闭、重开浏览器会继续使用自己的资料。下次若需要全新环境，应新建环境或明确重置资料。VPS 的 IP 和网站服务器上的既有记录不会因此改变。

## 路径与凭据

- 应用：`/Users/staff/Applications/MuCodeSandbox.app`，当前 **0.4.8**，build `68f265115b8a4c74`；首次部署版本 0.4.7 / `0d19579a2579270d` 另留历史。
- 项目：`/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox`。
- 本机连接配置：`/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199/`，目录权限 0700。
- 登录服务：`/Users/staff/Library/LaunchAgents/local.mucodesandbox.relay-dedione-lax.plist`，仅当前 Mac 用户，自动重连，本机登录时启动。
- 服务器规则：`/usr/local/libexec/mucodesandbox-relay-network`、`/etc/systemd/system/mucodesandbox-relay-network.service`。
- 私钥仅在上述本机私有目录内，不共享给 VM，不写进项目、文档或日志。Root 密码由用户在终端输入，没有保存。
- SSH 主机指纹采用用户确认的首次信任；不同路径连接匹配同一指纹，尚无来自供应商的独立指纹回执。
- 本轮没有更改服务器的 Root 登录策略；系统整体安全更新和 SSH 后量子密钥交换升级仍未验收。

## 验证记录

已通过：SSH 专用账号认证、shell 拒绝、远端监听拒绝、回环监听、账号 IPv6 拒绝规则命中、三个宿主接收端出口一致、全新 VM 内两个无应用代理 curl 接收端出口一致。

前两次安装浏览器时，出口核验在 apt 下载期间超时，防护撤销访问并停止 VM；没有关闭出口锁定。随后发现原 SSH 传输经过现有 TUN，已改为专用 Wi-Fi 直连。该发现与超时相关，但尚不能仅凭此认定全部超时原因。

改用物理 Wi-Fi 直连后，实际浏览器安装完成；正式 Chrome 155.0.8059.39 的首页显示 `166.88.36.199` / 美国 / Los Angeles / `America/Los_Angeles` / `en-US`。本轮没有放宽出口探针超时、取消锁定或关闭防火墙。

专用连接断开与恢复实测通过：主动停止仅本线路的 LaunchAgent，宿主 SOCKS5 请求失败；客体清空应用代理环境变量后的 HTTPS IPv4 字面地址请求也失败；出口核验失败后，VM 进入隔离，浏览器关闭。恢复专用连接后，手动重启 VM 与浏览器，出口仍为 `166.88.36.199`，防护 active、出口 verified、浏览器地区配置匹配。原环境全程保持停止。这是一次具体故障窗口，不是所有连接的接收端证明。

安装版独立窗口查看区域 1320×820，全屏查看区域 1470×875；真实客体桌面始终为 1600×1000 / 2× / 3200×2000 像素。右侧浏览器菜单、个人资料按钮和桌面底部完整可见；全屏原件：`test-results/dedione-native-fullscreen.png`。恢复后重新打开仍默认完整缩小展示。

私有验证记录：上述本机连接目录的 `guest-initial-verification.json`、`cut-and-restore.json`、`browser-open-job.json`。首次无资料检查记录发生在安装浏览器之前。Root 管理连接已关闭，持续连接只用受限 `mu-relay` 账号。

全天、休眠切网、VPS 重启和独立住宅出口仍不属于本轮完成范围。全新环境的 Claude Code 软件尚未单独安装与登录，本次命令行网络验证使用无账号 curl，不把它写成 Claude Code 客户端验收。

0.4.7 修正画面默认为“适合窗口”，保留固定 1600×1000 / 2× 客体桌面。17 项显示单测、实际 noVNC 夹具的默认完整显示 / 右下角输入 / 原始像素滚动 / 全屏 / 重开验证、TypeScript 构建以及候选应用包依赖与深度严格签名检查通过。

验证过程中未登录 Claude、未调用付费模型。
