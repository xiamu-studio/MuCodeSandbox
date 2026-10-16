# 加密上游无账号验收

## 当前试用包出口锁定组合

9621b0a 包于 2026-10-10 23:14:29 UTC 通过真实 VM 的 HTTPS 代理与
出口锁定组合独立复核：TLS 1.3、许可开放前测量、普通用户入口绕行
拒绝、错误用户名 / 密码 / 代理证书名称 / CA 拒绝，以及出口变化 /
测量异常撤销和正确配置恢复。十份物理抓包未批准外发 0，资源清理。
这项使用本地合成出口回执，不扩大为真实住宅、成功 DNS、实际桌面
浏览器 / CLI 或全天验收。报告 `egress-bridge-owner-https.json` 与
对应 `-evidence.json`；详见 [组合记录](egress-probe-validation.md)。

## 旧 7395e50 冻结包复验

2026-10-10 22:03:28–22:06:12 UTC 使用 7395e50 包内全部 45 个后台
模块和全新临时 VM 重验，22:06:35 UTC 独立复核通过。正确 CA / SNI /
认证、TLS 1.3、实际正文回执、错误 CA / 名称 / 凭据拒绝、代理失联
不直连和正确配置恢复均通过。五份保护状态双向物理抓包共
131 / 102 / 125 / 127 / 109 包，全部为批准 SSH 路径；没有物理
代理出口例外，测试正文和代理密码不可见。另以显式无防护直连抓包
正向确认能看到同一测试正文和响应，避免把抓不到任何数据误当加密。

本轮只修改验证脚本，不重建应用或浏览器。临时 VM / 基础镜像 / 证书
私钥清理，原运行环境保留。测试 CA 没有安装到 Mac 信任库。
报告 `encrypted-upstream-transport.json` 和同名 `-evidence.json`，
SHA-256 `d0c7bba756062673dd68e5b3cbf8b35bd25d78d4df9d91a982530d17f09f34b3`；
原始目录 `encrypted-upstream-transport-1791669808809/`。入口
`test:encrypted-upstream-transport` 与同名 `-evidence`。
不是浏览器 / CLI、住宅线路、Mac 切网或全天验收；TLS 仍由客体
转发服务验证，SSH 只运输已有代理数据，不替代上游 TLS 身份检查。

## 旧源码验证

本验证针对 `network.mode = "https"` 的严格透明网络。它使用独立临时 Linux VM、自签测试 CA 和真实 HTTPS CONNECT 认证代理，不登录 Claude、不调用付费模型、不使用住宅线路。

2026-10-09 14:38 UTC 开始的完整实机运行通过：TLS 1.3、正确 SNI 与认证、双向完整抓包、错误 CA / 名称 / 凭据、代理失联、恢复及明文抓包正向对照均取得证据。临时 VM、基础镜像和证书已清理，报告与 6 份抓包保留。

需要 Node.js 24.15+、Apple Silicon Mac、已安装 Lima，以及下载受信基础镜像和系统组件所需网络。不会使用或修改现有浏览器测试 VM；临时数据位于 `~/.mu-encrypted-verification-*`。

```sh
node scripts/verify-encrypted-upstream.ts --fixture-only
node scripts/verify-encrypted-upstream.ts
```

`--fixture-only` 只检查宿主上的测试 CA、SNI、TLS、CONNECT 和认证正反对照，不能证明 VM 防护通过。完整运行会创建和删除自己的 VM，首次准备基础镜像可能较慢。

完整验收检查：

1. VM 内未设置应用代理的明文 HTTP 请求，经带正确证书、服务器名和认证的 TLS 代理到达受控接收端；接收端确实收到测试请求体。
2. 物理网卡完整载荷抓包仅有批准代理、SSH 回复及 DHCP；抓包必须包含实际代理数据，且看不到测试请求体、响应体或代理 Basic 凭据。
3. 错误 CA、错误服务器名、错误凭据分别确实到达代理端点，但业务请求和直连绕过均失败；恢复正确设置后再次成功。
4. 代理退出后没有直接回退。
5. 最后单独显式切换到无防护的直接模式，抓取同一测试载荷，证明抓包能看见明文。这是临时环境的正向对照，不是严格模式允许直连。

报告：`test-results/encrypted-upstream.json`。原始抓包：`test-results/encrypted-upstream/*.pcap`。纯宿主对照另存 `encrypted-upstream-fixture.json`，不会覆盖完整 VM 报告。测试生成的凭据和 CA 仅用于本次本地实验，不是产品或用户凭据。

默认清理临时 VM 和证书。调试时设置 `MU_KEEP_FAILED_ENCRYPTED=1` 可保留失败环境，脚本仍尝试停止 VM；报告记录 `retainedDataDir`。保留目录包含测试私钥，仅用于复现和诊断。设置 `MU_ENCRYPTED_TEST_DATA` 为该报告的目录可复用已封存基础镜像，仍创建新的独立用户 VM；仅允许复用本脚本在 home 下创建的 `.mu-encrypted-verification-*` 目录，结束后仍按默认规则清理。

此验证证明指定 HTTPS 上游的证书、认证、加密和故障路径，不代表所有 VPN 协议、多层热点网络、商业线路、长期运行或最终出口固定已经验收。最终出口锁定需要独立测试。

首个运行曾因抓包批量读取与过早停止而没有捕获很快完成的明文正向对照，整体结果未标为通过。验证器改为 systemd 管理的双向 `--immediate-mode` 捕获，并等待最后数据到达再停止；上述完整通过结果来自修复后的重新实测。
