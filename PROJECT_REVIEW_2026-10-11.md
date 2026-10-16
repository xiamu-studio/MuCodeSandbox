# MuCodeSandbox 项目检查报告

检查日期：2026-10-11。检查范围：`/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox` 全部源码、文档、配置、Git 状态、依赖，以及已安装应用 `~/Applications/MuCodeSandbox.app`。
检查方式：阅读核心代码（`server/`、`desktop/`、`shared/`、`native/`）、运行 `tsc`、运行全部单元测试、运行 `npm audit`、扫描硬编码凭据、对照文档与实际状态。

---

## 一、总体结论

| 维度 | 评级 | 一句话结论 |
| --- | --- | --- |
| 架构 | 良好 | 边界划分清晰，安全设计思路成熟；代码风格过度压缩，长期维护成本高 |
| 进度 | 中等偏好 | 核心功能已实现并可用；文档对完成度描述诚实；大量外部条件项暂缓 |
| 安全 | 良好，有少量需修复项 | 未发现高危漏洞；2 个中危、若干低危；依赖链有 2 个 critical 级别告警需处理 |
| 工程卫生 | 差 | Git 仅 1 次提交、310 个未跟踪文件、无远程仓库；`release/` 占 16 GB 历史包 |

**最需要立即处理的三件事**：
1. 把当前工作提交到 Git 并配置备份 / 远程（现在所有 10-09 之后的工作都只存在于工作区，一次误操作即丢失）。
2. 修复 `server/lima-config.ts:39`：非透明模式下代理账号密码会明文写进 Lima YAML 和客体 `/etc/environment`，并被快照原样复制。
3. 处理 `stun` 依赖链（critical：`parse-url`、`stun`；high：`ip`、`meow`），或将验收实验室从打包产物中剥离。

---

## 二、项目架构

### 2.1 整体结构

```
Mac 宿主
├── Electron 主进程 (desktop/main.cjs, 154 行)
│   ├── 管理窗口：仅加载 http://127.0.0.1:4367，sandbox + contextIsolation
│   ├── 客体浏览器窗口：加载本地 VNC 画面页
│   └── 旧版本机浏览器 (WebContentsView + session.setProxy)
├── 本机服务 (server/service.ts, Express)
│   ├── 仅绑定 127.0.0.1；Host / Origin 校验；CSP nonce
│   ├── /api/* 需 Bearer token（随机 32 字节，嵌入首页 bootstrap）
│   ├── 首页需私有 launch 链接换取 HttpOnly 会话 Cookie (ui-session.ts)
│   ├── Manager → SQLite (store.ts) → Lima runtime (runtime.ts)
│   ├── Terminal / GuestBrowser：一次性票据 WebSocket
│   └── HostBridge：短期目录能力 + 只读 Git (native/BridgeHelper.swift + sandbox-exec)
└── Lima / Apple Virtualization
    └── Ubuntu 24.04 ARM64 客体
        ├── nftables 默认拒绝 + mu_lease 45 秒许可
        ├── sing-box TUN + DoH 透明代理 (mu-net 专用用户)
        ├── Chrome for Testing 156 (dev 用户，renderer sandbox)
        └── TigerVNC → SSH Unix socket 转发 → Electron
```

### 2.2 代码规模（实际统计）

| 目录 | 行数 | 说明 |
| --- | --- | --- |
| server/ | 6,368 | 核心服务，58 个文件 |
| scripts/ | 19,389 | 专项验证脚本，远多于产品代码 |
| tests/ | 3,997 | 176 个单元 / API 测试 |
| src/ | 1,098 | React 界面 |
| native/ | 443 | Swift 桥接助手、网络监测、C 探针 |
| shared/ | 236 | 类型契约 |
| desktop/ | 187 | Electron 入口 |

### 2.3 架构优点

- **安全边界明确**：管理面（Mac）/ 执行面（VM）/ 网络面（TUN + nft）三层分离，每层都有独立的认证或权限约束。
- **防御深度合理**：客体内 dev / mu / mu-net / root 四级用户分离；宿主桥接用 fd 锚定 + `O_NOFOLLOW` + `st_nlink==1` + `sandbox-exec` 多重约束；备份用 AES-256-GCM + scrypt + AAD 头 + tar 白名单。
- **事务化恢复**：快照 / 磁盘恢复 / 浏览器安装都采用 journal + 回滚副本 + HMAC 清单，考虑了中途强退。
- **不信任客体**：宿主每 8 秒复核客体规则、路由、DNS，异常即隔离停机。
- **三个 ADR 记录了技术选型理由**（TypeScript + Electron、Lima VZ、SQLite 串行化），文档中对"不保证"的边界写得诚实。

### 2.4 架构问题

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| **代码极度压缩** | `server/*.ts` 普遍单行 200-400 字符，无空格、无换行（例：`service.ts` 284 行却承载全部 50+ 路由） | 代码审查、diff、他人接手困难；错误定位到"行"几乎无意义 |
| **验证脚本膨胀** | `scripts/` 19K 行、`package.json` 约 190 个 `test:*` 脚本 | 大量脚本是一次性专项，彼此重叠；没有统一的测试矩阵入口 |
| **Manager 单体** | `server/manager.ts` 484 行，承担生命周期、网络、出口、浏览器、快照、磁盘等全部协调 | 任何功能变更都碰同一文件 |
| **文档体量倒挂** | `docs/` 110+ 份 Markdown，大部分是"验证记录" | 有价值，但当前状态分散在 PROJECT_OVERVIEW / project-status / TODO / deferred 四处；更新时容易不一致 |
| **Chrome for Testing 作为日常浏览器** | 文档已承认 | 测试发行版无自动更新、无稳定渠道保障；P1 待办 |
| **`asar: false` + `hardenedRuntime: false` + adhoc 签名** | `package.json build` | 测试版可接受；但意味着任何同用户进程可改写 app 内 JS |

---

## 三、项目进度

### 3.1 已核实的事实

| 项目 | 文档声称 | 实际核实 |
| --- | --- | --- |
| 单元测试 | 176 项通过 | **已复现**：`node --test` 176 pass / 0 fail，15.8 秒 |
| 类型检查 | - | **已复现**：`tsc --noEmit` 无错误 |
| 安装包 buildId | `7c2737978926f345` | **一致**：源码 `build-info.json` 与 `~/Applications/MuCodeSandbox.app` 相同 |
| 签名 | 本机临时签名 | **一致**：`codesign` 显示 `Signature=adhoc`，`TeamIdentifier=not set` |
| 源码中无 TODO/FIXME | - | **一致**：`server/ native/ desktop/` 无任何未完成标记 |
| 硬编码凭据 | 无 | **一致**：源码中仅测试夹具密码（`tui-fixture` 等），无真实密钥 |

### 3.2 功能完成度

| 能力 | 状态 |
| --- | --- |
| VM 创建 / 启停 / 删除 / 资源配置 | 已实现，有测试 |
| 终端、Claude Code 安装入口 | 已实现；当前用户 VM 尚未安装 |
| 严格应用代理 / 严格透明代理 / WireGuard | 已实现，有限定验证 |
| 出口核验、45 秒联网许可、8 秒复核 | 已实现 |
| 客体浏览器（VNC 画面、Retina 适配、资料重置、版本升级 / 恢复） | 已实现到 0.4.5 |
| 受限宿主桥接 + 只读 Git | 已实现，Swift 助手 + sandbox profile |
| 离线快照、加密备份导入导出、磁盘恢复事务 | 已实现 |
| 本地首页、网络回执 / 日志 | 已实现 (0.4.4) |
| CLI 系统识别审计 | 两轮完成，仅为源码脚本，未进应用 |

### 3.3 未完成 / 暂缓（文档已明确）

- **P0 持续项**：CLI 环境读取 / 发送审计、工具授权后 VM 暴露、机器 / 设备标识关系、登录前状态表达、多目的端出口证明。
- **P1**：稳定浏览器渠道、CLI 正式 4 GB 资源、外部链接归属、重置范围说明。
- **外部条件暂缓 (V1-V7)**：真实休眠、切网、24 小时、住宅线路、第二台 Mac、断电、全首包抓取。
- **产品范围暂缓 (P1-P7)**：正式签名公证、自动更新、浏览器自动升级、Mac 本机出口、macOS VM、Claude Desktop、Windows。

### 3.4 进度方面的担忧

1. **Git 状态极度危险**
   - 仅 1 次提交（2026-10-09 `47e34e9`）；之后 0.4.0 → 0.4.5 的全部演进（28 个修改文件 +3,378/-261 行、310 个未跟踪文件）均未提交。
   - 无远程仓库。工作目录是唯一副本。
2. **磁盘占用失控**：项目 18 GB，其中 `release/` 16 GB 保留了 50+ 个 360 MB 历史候选包（`installed-before-*`、`*-candidate`）；`test-results/` 1.2 GB 含 624 个 `.pcap`。
3. **版本演进速度 vs 验证覆盖**：3 天内 0.4.0 → 0.4.5，文档也承认"旧包测试不自动代表新包重新通过"。当前 0.4.5 只重跑了单元测试和画面检查，13 项 VM 实机验收仍绑定 0.4.0 的 `9621b0a` 包。
4. **CLI 审计结论对产品目标的影响**：审计已证实授权 Bash 后 `systemd-detect-virt` 返回 `apple` 并回传模型。这意味着"独立 Linux 环境"路线在"不被识别为 VM"这个隐含目标上存在原理性天花板，文档已如实写明，但产品定位需据此重新确认。

---

## 四、安全性

### 4.1 已确认的安全优点

- 服务仅回环监听；Host 头 + Origin 双校验防 DNS rebinding；CSP 使用 nonce；`X-Frame-Options: DENY`。
- API Bearer token 32 字节随机、`timingSafeEqual` 比较；首页需 launch secret 换 HttpOnly + SameSite=Strict Cookie，防止本地代理拿到 bootstrap。
- Electron：全部窗口 `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`；preload 只暴露 2 个受限 IPC；IPC 校验 `senderFrame.url`；导航只允许 http/https；`setWindowOpenHandler` 拒绝弹窗；权限请求全部拒绝；WebRTC `disable_non_proxied_udp`；QUIC 关闭。
- 全部子进程 `shell:false`，参数数组；客体脚本中的用户数据经 `shellQuote` 或 `JSON.stringify` 双重包裹进 heredoc，未发现注入点。
- 凭据 AES-256-GCM、每次随机 IV；密钥文件 `wx` + 0600；数据目录 0700；SQL 全部参数化；日志经 `redact()`。
- 终端 / 画面票据 192 位随机、一次性、15 秒过期、连接数上限。
- 桥接 token 只存 SHA-256；fd 锚定路径、拒绝符号链接和硬链接、`sandbox-exec (deny default)`、Git 禁用 hooks / fsmonitor / ext-diff / submodule。
- nftables 规则生成前校验每个 IP / 端口 / UID，`nft --check` 后再应用。
- 备份：salt + nonce 随机、header 作 AAD、先验 tag 再解压、解压炸弹上限、tar 白名单。

### 4.2 发现的问题

#### 中危

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| M1 | `server/lima-config.ts:23,39` | `transparent=false` 时，含账号密码的代理 URL 明文写入 Lima `env:`，Lima 落到宿主 `~/.lima/<实例>/lima.yaml` 并传播到客体 `/etc/environment`（客体内所有用户可读，包括运行不受信代码的 dev）；`snapshots.ts:74` 再把 `lima.yaml` 原样复制进快照 | 有凭据时强制走已有的 root:dev 0640 文件路径；快照中排除或加密 `lima.yaml` 的 env |
| M2 | `server/process.ts:59` | `child.stdin.end(input)` 无 `error` 监听；子进程提前退出（如 `sudo -n` 失败、`bash -s` 早 exit）触发 EPIPE 未处理事件，可能导致整个管理服务崩溃 | 加 `child.stdin.on('error', () => {})`（`host-bridge.ts:189` 已这样做） |
| M3 | `package.json` 依赖 `stun@2.1.0` | 引入 `parse-url` (critical XSS)、`parse-path` (high 授权绕过)、`ip` (high SSRF 分类错误)、`meow`/`trim-newlines`/`yargs-parser`。`npm audit --omit=dev` 共 9 项（2 critical、4 high、3 moderate），全部随安装包发布到 161 个 node_modules | `stun` 仅用于 `acceptance-lab.ts`（可选实验室）。方案：改用 Node 原生 dgram 实现最小 STUN 服务；或把实验室移出打包 `files`；至少 `npm audit fix` 可修复部分间接依赖 |

#### 低危

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L1 | `server/network-guard.ts:104-106` | `sudo tee` 先按默认 umask 创建含凭据的文件再 `chmod 0640`，存在短暂 0644 窗口 | 先 `install -m 0640 -o root -g dev /dev/null <file>` 再写入 |
| L2 | `server/store.ts:18-19` | 已存在的 `credentials.key` 不检查权限和长度；0644 或被截断的密钥文件会被静默接受 | 加载时 `fstat` 并校验 mode 0600、长度 32 |
| L3 | `server/terminal.ts:34` | `issue` 与 `upgrade` 之间环境被删除时 `store.get()` 抛异常，socket 未销毁 | try/catch 并 `socket.destroy()` |
| L4 | `server/backups.ts:32` | scrypt `N=32768`（约 32 MiB）对离线可攻击文件偏低 | 提到 `N=2^17` 并同步提高 `maxmem` |
| L5 | `server/backups.ts:149` | 用错误消息子串 `'authenticate data'` 判断认证失败，跨 Node / OpenSSL 版本脆弱 | 改用错误码 |
| L6 | `server/validation.ts:105` | 敏感目录黑名单仅 `.ssh .gnupg .aws .config Library`；`.docker .kube .azure .npmrc` 等未覆盖 | 扩充黑名单或改白名单 |
| L7 | `server/lima-config.ts:74-77` | Node 压缩包仅与同源 `SHASUMS256.txt` 比对，无签名校验 | 像 Ubuntu 镜像一样把 SHA256 钉在源码里 |
| L8 | `server/lima-config.ts:83` | `@anthropic-ai/claude-code` 全局安装未钉版本 | 设计如此，但需在文档中标明供应链风险 |
| L9 | `native/BridgeHelper.swift:133-139` | 超限时发 SIGTERM 不 `waitpid`，留僵尸进程；无 SIGKILL 兜底 | 加 reap 和 kill 升级 |
| L10 | `server/service.ts` `allowedOrigin` | 缺少 Origin 头时视为允许（`!origin \|\| ...`）；terminal WebSocket 复用此函数 | 对 /api 因有 Bearer 影响有限；WebSocket 建议像 guest-browser 路径一样要求 Origin 必须存在 |
| L11 | `server/service.ts` / `desktop/main.cjs` | launch secret 在进程生命周期内可重复使用，并写入 `service-info.json`（0600） | 同用户内风险；可改为一次性或短期有效 |
| L12 | `server/store.ts:54-63`、`snapshots.ts:167` | 单条损坏 / 无法解密的记录会让 `list()` 整体抛错 | 逐行隔离错误 |

#### 信息 / 卫生

- `test-results/` 的 624 个 `.pcap` 为真实网络抓包，可能含代理握手或请求元数据；`.gitignore` 已排除，但如果整个目录被打包分享会泄露。建议单独加密归档或清理。
- `release/` 内 50+ 历史 `.app` 每个都含 `dist-server`、`node_modules` 和 `build-info.json`，均为 adhoc 签名、可被同用户改写。
- `hardenedRuntime: false`、`identity: '-'`：测试版可接受，正式分发前必须改。
- 开发依赖 `electron-builder 26.15.3` 链上 8 项 moderate，不进入产物。

### 4.3 产品层面的安全边界（文档已声明，这里确认合理）

- 客体 root 完全失陷后可改 nft 规则；8 秒复核存在时间窗。这是正确的声明。
- VM 身份（Apple 虚拟化、`systemd-detect-virt`）无法对获授权命令的 CLI 隐藏。
- 不防同一 macOS 用户下的恶意进程（密钥文件、SQLite、adhoc app 都可被改写）。
- 出口回执不等于每条连接的公网证明。

---

## 五、建议的处理顺序

| 优先级 | 事项 | 工作量 |
| --- | --- | --- |
| 立即 | `git add` 全部源码 / 文档并提交；配置远程或至少 Time Machine 确认 | 10 分钟 |
| 立即 | 清理 `release/` 中确认不再需要的历史包（保留 `candidate`、`retina-display-candidate`、当前安装对应包即可），回收约 14 GB | 30 分钟 |
| 本周 | 修 M1（凭据进 Lima env）、M2（stdin EPIPE） | 半天 |
| 本周 | 处理 M3：用原生 dgram 替换 `stun`，或把 acceptance-lab 移出打包 | 半天 |
| 本周 | 修 L1、L2、L3、L10（均为几行改动） | 2 小时 |
| 下阶段 | 决定 Chrome for Testing → 稳定渠道策略（P1 A4） | 待排期 |
| 下阶段 | 对 0.4.5 包重跑至少核心 VM 实机验收（启停、透明代理、出口、快照），把 13 项验收从 0.4.0 绑定更新到当前包 | 1-2 天 |
| 下阶段 | 代码格式化：至少对 `server/` 启用 Prettier 并提交一次纯格式化 commit，恢复可读性 | 半天 + 测试 |
| 正式发行前 | Apple 开发者签名 + 公证 + `hardenedRuntime:true` + `asar:true` | 外部条件 |

---

## 六、检查方法说明

- 读取：`README.md`、`PROJECT_OVERVIEW.md`、`docs/architecture.md`、`docs/project-status.md`、`docs/TODO.md`、`docs/cli-environment-audit-2026-10-11.md`、`package.json`、`.gitignore`、`build-info.json`。
- 逐行审阅：`server/service.ts`、`server/ui-session.ts`、`desktop/main.cjs`、`desktop/preload.cjs`、`server/acceptance-lab.ts`（部分）。
- 委托并行审阅：`server/store.ts`、`process.ts`、`validation.ts`、`host-bridge.ts`、`terminal.ts`、`guest-mounts.ts`、`guest-privileges.ts`、`lima-config.ts`、`network-guard.ts`、`backups.ts`、`import-seed.ts`、`snapshots.ts`、`native/host-command.sb`、`native/BridgeHelper.swift`。
- 执行：`tsc --noEmit`（通过）、`node --test tests/*.test.ts`（176/176 通过）、`npm audit --registry=https://registry.npmjs.org`（17 项，生产 9 项）、`codesign -dv` 已安装应用、`git status / log / diff --stat`、`du`、`rg` 凭据与危险模式扫描。
- 未执行：任何 VM 专项脚本（会启动 VM、下载组件或执行故障注入）、Playwright UI 测试、Lima 实机验收。
