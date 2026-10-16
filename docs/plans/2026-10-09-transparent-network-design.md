# Linux 透明网络设计

目标版本：0.3.0。范围：Linux 客体 TCP、代理内加密 DNS、故障关闭及实际检测。

## 数据路径

应用不再依赖代理环境变量，IPv4 TCP 通过 sing-box TUN 转为上游 HTTP CONNECT 或 SOCKS5 TCP。DNS 由客体本地解析服务交给 TUN，再使用经同一代理的 DoH。普通 UDP、IPv6和未授权物理出口拒绝。管理 SSH、DHCP、共享服务回复及 loopback 保留明确例外。

sing-box 使用独立 mu-net 用户和必要网络能力运行。物理代理连接只放行该用户的指定 IPv4/端口；普通开发进程不能直接借用此放行项。TUN 接口只放行 IPv4 TCP 和 DNS，不放宽整个物理网卡。无 direct outbound、无 DNS 直连兜底。

## 生命周期

复用 0.2 的防护准备和保守停机流程。宿主从官方发布下载固定 sing-box 1.14.3 ARM64 包，校验固定 SHA-256，通过 Lima 复制到客体并安装。凭据配置 root:mu-net 0640，开发用户代理环境为空。

启动先保持客体默认拒绝，配置并检查 sing-box，启用 TUN 后验证服务、接口和防火墙，最后标记运行。停止先收紧为无代理端点的保守规则，再停止 TUN 并恢复 DNS，最后停止 VM。服务死亡或路由消失时，物理出口仍被拒绝。旧模式关闭 TUN 和 DNS 覆盖，不改变用户的原代理选择。

## 验收

- 未设置代理的 curl、Python socket、Git、Node 使用本地认证 HTTP CONNECT 出口。
- 系统 DNS 和主动 DNS 查询通过代理 DoH；物理 DNS 抓包为零。
- 物理网卡绑定、直接访问代理端点、普通 UDP 和 IPv6无法绕过。
- 代理断线、TUN 服务停止、VM 重启均不退回直连；故障后可由管理器恢复。
- 原 0.2 应用代理与拒绝绕过测试继续通过。
- 桌面/手机 UI 显示模式、实际服务和防火墙状态，最终应用包重复检查。

## 边界

本轮不覆盖 Mac 本机网络，不消除首个镜像引导窗口，不抵御使用 sudo/root 拆除规则。HTTP 线路必须支持 CONNECT 到目标端口；UDP 和 IPv6不提供转发。DoH 默认使用 Cloudflare IPv4，经代理传输，证书验证开启。

## 依据

- [sing-box TUN](https://sing-box.sagernet.org/configuration/inbound/tun/)
- [sing-box HTTP](https://sing-box.sagernet.org/configuration/outbound/http/)
- [sing-box SOCKS](https://sing-box.sagernet.org/configuration/outbound/socks/)
- [sing-box DNS HTTPS](https://sing-box.sagernet.org/configuration/dns/server/https/)
- [sing-box 官方发布](https://github.com/SagerNet/sing-box/releases/tag/v1.14.3)
