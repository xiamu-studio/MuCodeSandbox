# 六项改进：实现与实际验收

日期：2026-10-11。源码 / 候选应用 0.4.6，build `63a939051fc7b7ec`。
用户已批准交付，0.4.6 已安装并运行：PID66485、build63a939051fc7b7ec；实际本机窗口已确认。
测试目录独立，未修改正在运行的越南环境或 Clash 全局配置。

## 限定范围结果

| 工作 | 实际结果 | 证据 / 限制 |
| --- | --- | --- |
| 正式 Chrome | Google 稳定 ARM64 155.0.8059.39，官方签名链与 SHA通过；Google Chrome 品牌，无 CfT 提示；sandbox检查通过 | [签名回执](../test-results/device-signal-review/google-stable/signature-bda393bb-2afc-4172-aaf0-7f10d0f7a628/verification-receipt.json)、[实际画面](../test-results/normal-linux/stable-browser.png)。空白测试 VM 从未用156打开资料；155不得直接打开156旧资料 |
| 资料与绘图 | 合成Cookie / localStorage关闭重开仍存在；Canvas像素正确；Worker美国时区一致 | 本次实际稳定版保存 / 重开，不是所有站点或完整迁移验收 |
| 主机名 | `desktop-e210cdf6` 重启前后不变，真实machine-id保持，Lima重生iid只更新审计 | 原联合iid键会导致每次改名，实测发现并修复；不改Mac / DMI / machine-id |
| CPU / 内存 | 客体4核、约3904MiB可用总内存；浏览器读4 / 4；浏览器绘图与真实CLI固定响应同时完成，无OOM日志 | 3秒绘图161帧，CLI合成响应81ms；结束时747MiB使用。仅轻量并发，不代表长时 / 大仓库 / 编译压力验收 |
| 美国线路 | 独立B1013节点；browser/ipify与curl/ipwho三轮一致167.17.68.145，US / LosAngeles；时区America/Los_Angeles | 功能测试，不是住宅 / 独享证明；原配置hash不变；该测试连接已关闭 |
| 出口故障关闭 | 关闭专用测试线后curl失败、访问核验失败并隔离；没有客户端直连备用路线 | 本次短会话；不是所有连接的接收端证明，也不是全天 / 完整首包故障窗口抓包 |
| 固定桌面 | 客体1600×1000、DPR2；RFB3200×2000，Mac DPR2下显示1600×1000；缩放查看窗口不改guest screen | 原始像素模式实测；外接屏和高分辨率长期压力仍未测 |
| 客体声音 | 真正浏览器440Hz音源经PulseAudio、SSH、WS到Mac，聚合PCM非零，估算频率在容差内 | [实际来宾回执](../test-results/normal-linux/runtime.json)；48kHz双声道；Mac原生AudioContext输出另测通过。物理扬声器可听效果待用户试用，未录音 |
| CDP / 字体 | 完成[生命周期审查](cdp-lifecycle-review-2026-10-11.md)，保留现有控制链；字体未发现本次展示故障 | 未关闭autoAttach或伪造指纹，未改浏览器内核 / GPU |

## 本次发现并修复的真实问题

1. 出口许可尚未打开时，旧探针的curl本地解析 + DoH子连接尝试直接连DNS，
   被lease防火墙拒绝，导致正常节点启动失败。现在使用受限的本地SOCKS5h
   入口，显式由sing-box受控DoH解析，经同一upstream出站；未放宽nft / lease。
   缺失通道立即拒绝，不回退无proxy。实际节点和本地SOCKS域名拒绝夹具均验证。
2. Lima每次开机变化instance-id；以真实machine-id判断同一设备并保留名称，
   iid仅记录实际变化。克隆machine-id变化时生成新名称，真实标识不改。

本地CLI只连接由测试转发器限制的假API，使用假凭据；没有真实账号或
Anthropic请求。CLI结果中的costUSD由合成usage计算，不是支付记录，实际
付费模型请求为0。模型显式指定，避免空白bare资料没有默认model导致夹具400。

## 验收脚本 / 回执

- `scripts/verify-normal-linux.ts` → [runtime.json](../test-results/normal-linux/runtime.json)。
- `scripts/verify-normal-linux-package.mjs` → [package.json](../test-results/normal-linux/package.json)：
  实际Electron包、深度严格ad-hoc签名、全部编译资源摘要、隔离数据 / 服务、renderer sandbox。
- 全部240项Node测试通过，[日志](../test-results/normal-linux/all-node-unit.log)。
- TypeScript、构建与打包通过；正式Apple签名 / 公证继续暂缓。

候选包：`release/normal-linux-candidate/mac-arm64/MuCodeSandbox.app`。
现有越南浏览器继续选择旧批准recipe，不自动拿155读其156资料。
用户批准后已替换应用并核对签名、编译模块和运行build身份。现有越南VM调整为4核/4GiB，原地区/线路/156资料保留，防护核验与固定桌面通过。见 [安装交付回执](../test-results/normal-linux/installed.json)。

本次没有进行真实休眠、换网、24小时、第二台Mac、断电或所有首包窗口测验；
没有恢复浏览器源代码构建、macOS VM、Network Extension或Claude Desktop工作。

## 下一步网络方向

用户已计划VPS中转 + 静态住宅最终出口；目前缺线路及服务器条件，尚未部署。
见 [VPS + 静态住宅搭建方案](network-vps-static-residential-plan.md)。
