# 网络防护与环境配置设计

目标版本：0.2.0。用户已要求继续开发，并明确列出差距、工作与验证。

## 本轮交付

- Linux 仅代理联网策略：nftables 默认拒绝客体外联，允许指定 IPv4 代理端点、SSH/已配置端口的回复、客体内部回环和必要 DHCP；拒绝其他 TCP、UDP、DNS 与 IPv6。
- 网络防护准备、启动验证、持久启动规则及实际防火墙状态。代理不可用时请求失败，不退回直连。
- 独立 IANA 时区与语言配置，应用到 Linux 和桌面浏览器；读取浏览器实际值验证。
- 浏览器代理失败关闭验证、会话隔离保持；不把浏览器配置宣称为 macOS 进程级防火墙。
- 与参考产品的差距和可执行验收表。

## ADR-004：先实施拒绝绕过的代理策略

采用：客体 nftables + 现有 HTTP/SOCKS5 应用代理。忽略代理配置的程序会被阻断，无法透明联网。

备选：sing-box TUN 可以透明承接应用流量，但还需要二进制校验、TUN 生命周期、DNS 路由与故障恢复。macOS 全局 TUN 或进程过滤需更高权限及分发能力，影响范围更大。本轮选择客体内可实测、不会修改宿主网络的方案，TUN 留为明确后续事项。

上游域名在宿主解析为 IPv4，运行期间固定端点，客体无须直接 DNS 查询代理。回环代理通过客体默认网关连接本机代理。只允许代理端点的 TCP，不允许泛化的 established 外联例外。

## ADR-005：已有环境安全迁移

新的严格环境首次使用官方镜像进行可信引导，安装防火墙后才标记可用；首次安装阶段不是零网络引导。后续启动由 systemd 在 network-pre.target 之前加载持久规则。

已有环境不能直接勾选严格模式后启动。先以原配置启动，执行准备防火墙，安装并加载保守规则后停止。此时启动防火墙已就绪，才能保存严格配置。所有已准备的环境通过管理器停止时重新装配没有代理端点的保守启动规则，防止后续切换或修改严格配置时沿用旧出口。异常停机后保存严格配置也要求该保守记录。

规则只操作 inet mu_egress 表，不清空系统其他防火墙。启动安装或校验失败则停止 VM，不暴露终端。停止防火墙服务不清空规则。

## ADR-006：浏览器独立环境配置

Electron 按 WebContentsView 使用 CDP 的时区、Locale 和 User-Agent/Accept-Language 配置，保留真实浏览器标识。每个视图分别应用，不能只在进程启动时设置全局时区。配置失败不打开远程网页。实际检测读取浏览器标准 API，无页面内容或登录数据。

不伪造 Canvas/GPU/字体、不宣称与参考应用指纹防护等同。浏览器固定代理及 WebRTC/QUIC 限制仍不是操作系统层对所有子进程的流量封锁。命令行 Chrome 预览不提供同等独立环境保证。

## 威胁边界

本轮防护覆盖客体应用绕过代理及代理失效，不覆盖有 root/sudo 权限的人或程序主动删除规则。当前开发用户保留安装工具需要的 sudo 能力。宿主桥接与 Claude Desktop 尚未开放，普通宿主程序不在客体防火墙范围内。

## 验证计划

1. 自动测试验证输入限制、旧配置兼容、原子规则生成、无宽泛 established 例外、失败不标记就绪。
2. 真实 VM 使用本机测试代理：代理成功；直接 TCP/IPv4、IPv6、UDP/DNS 失败；代理关闭后无回退；重启后规则仍在。
3. 本机收包统计与客体规则计数共同确认阻断，不能仅依靠超时。
4. 两个桌面浏览器配置不同时区/语言，实际读值一致；Cookie 隔离；代理关闭后请求失败。
5. UI 在桌面/手机尺寸展示配置与状态，生产 .app 重复验证关键流程。

实施状态：实现完成。实机、界面及打包验收结果见 [../verification.md](../verification.md)，待办见 [../gaps-and-validation.md](../gaps-and-validation.md)。

## 官方依据

- [nftables 基础链与默认策略](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains)
- [systemd 启动目标](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html)
- [Chrome DevTools Protocol Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)
- [Electron session](https://www.electronjs.org/docs/latest/api/session)
