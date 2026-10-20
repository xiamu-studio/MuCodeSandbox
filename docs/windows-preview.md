# Windows Hyper-V 开发预览

本轮只交付虚拟机与网络防护的独立开发入口，不把 Mac 桌面应用标为已支持 Windows。真实 VM 启动、客体内核断网及 Windows 故障场景尚未验收。

## 隔离现有 Mac 版本

- 基线为 `cfcb5f9263dcd02cfa725e6d9aee80b065b98aa1`（0.4.65），开发分支 `codex/windows-hyperv`。
- Mac 的 Manager、Lima/VZ 配置、Swift 助手、桌面入口与打包命令保持原样。Windows 预览通过单独 CLI 进入，未接入现有 Manager。
- 唯一共用源文件调整是 `measureEgress` 的 TypeScript 参数类型收窄为实际使用的两个方法，函数运行逻辑不变。
- Windows 使用独立数据根和独立镜像，不读取 Mac 数据库、虚拟磁盘、登录资料或代理配置。不改版本号，不生成或安装 Mac 新包。

## 本阶段设计

每环境独立 Hyper-V VM、内部交换机、管理密钥和固定管理子网。创建时先安装虚拟网卡 ACL，再允许启动；两方向默认拒绝全部 IP，仅放行管理宿主与客体间的 SSH。不开通 NAT、ICS、物理桥接或默认交换机，不更改其他 VM。

Ubuntu x86_64 内继续使用现有 nftables 默认拒绝、sing-box TUN、受控 DNS 和 45 秒内核联网许可。业务 UDP/IPv6 不放行。宿主 SSH 反向转发仅连接明确配置的上游；无直连备用路径。出口通过至少两个不同接收端核验后才激活业务许可。失败会分别尝试断开唯一宿主通道、撤销客体许可和关闭 VM；一次失败的会话不可恢复续期。

网络快照独立轮询，不受出口探测等待阻塞；地址、DNS、路由变化、快照失败或明显休眠间隔触发关闭。快照仅用于内存摘要，不写入代码或常规日志。真实切网/休眠尚需实机验证。

镜像入口采用 Canonical 官方 AMD64 Azure VHD，并转换为 VHDX。该镜像使用 BIOS，因此本阶段为 Generation 1 VM；不关闭宿主或其他 VM 的 Secure Boot。正常云镜像、Generation 2 与 Secure Boot 镜像链另行验证，未声称已实现。

## 前置条件

Windows 11 专业版、可用的 Hyper-V、管理员 PowerShell、Windows OpenSSH、Node.js 24.15.0 或更高版本。开发预览暂以管理员运行生命周期操作；产品化时需要拆出最小权限的宿主代理，不能把管理员运行开发 CLI 当作最终权限模型。

`npm run windows:dev -- doctor` 只读检查。本轮实际检查显示本机缺少 Hyper-V 管理模块及运行中的 VM 管理服务，且当前进程未提升权限，因而真实 VM 测试未执行。CPU/本机地址等检查资料不存入本文件。

管理员可运行 `scripts/windows/enable-hyperv.ps1` 启用功能。脚本使用 `-NoRestart`，不会自动重启。需要先得到用户对本机启用步骤的回复；重启由用户保存工作后自行安排。

## 本地验证

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run test:windows
npm run build
npm run windows:dev -- doctor
```

`--ignore-scripts` 适用于本阶段 CLI 和测试，不代表 Electron 原生终端组件已构建。预览不启动 Electron，不打开浏览器，不访问 AI 网站，不代替用户登录。初检使用系统 Node.js 24.14.1，随后从官方来源下载并核验 Node.js 24.15.0，在独立工具目录重跑本轮测试、基线对照和完整构建，均以该版本记录最终结果；未更改系统 Node 安装。

本地合成 HTTPS 代理只接受两个 RFC 5737 测试地址，将它们转到宿主回环接收器，拒绝其他目的地。证书及私钥现场生成，保存在临时目录或独立数据根中，测试正常结束后清理临时证书。

## 准备客体镜像

以下是待实机验证的开发流程，不是已完成的验收结果：

1. 启用 Hyper-V 并完成必要重启，重新执行 `doctor`。
2. `npm run windows:dev -- download-base` 下载固定版本的 Canonical VHD 归档，核验固定 SHA-256 后提取镜像；提取可能占用数十 GiB 磁盘。记录命令返回的本地路径和提取文件的 SHA-256，仅保存在本机。
3. `npm run windows:dev -- download-tunnel` 下载并核验固定版本 AMD64 sing-box。
4. 在独立数据根创建本地配置 JSON，填入镜像路径、摘要和自己批准的上游。配置结构见 `server/platform/windows/config.ts`。本机配置和凭据不应提交到 Git。
5. `npm run windows:dev -- create <本机配置.json>` 创建停止状态的隔离 VM。
6. `npm run windows:dev -- bootstrap <本机配置.json>` 通过唯一批准的 SSH 转发安装 Ubuntu 包和隧道组件，写入默认关闭规则后停止 VM。只访问软件包来源，不执行账号测试。HTTPS 代理的初始化兼容性仍需验证，初始化失败不得绕过证书或改走直连。
7. 只有全新、未承载用户资料且不含代理用户名/密码的构建 VM，才能执行 `freeze-base`；该操作清理当前管理授权与 cloud-init 状态，停止 VM 并导出本地实验基础盘。它不是用户环境备份/迁移功能，也不是完成隐私审计的分发镜像。
8. 对导出盘记录本地 SHA-256，以该盘启动下面的完全本地实验。

`run <本机配置.json>` 是显式启动生产路径的开发命令，会使用现有公共 IP 接收服务核验出口；本轮没有运行它。测试入口使用本地接收器覆盖此路径，不访问这些公共接收服务。

## 真实 VM 合成实验（待执行）

```powershell
npm run windows:lab -- <本地实验基础盘.vhdx> <SHA-256>
```

需要本机 OpenSSL（默认使用 Git for Windows 自带版本，或通过 `MU_OPENSSL_PATH` 指定）。只创建新测试 VM，不导入用户账号/文件，不删除既有 VM。测试 VM 最终停止并保留，以便检查。基础盘必须已含 nftables、curl、Python 和固定版本 sing-box；本地实验本身不联网安装包。

实验设计覆盖：核验前拒绝业务、两个本地 HTTPS 回执、批准通道下开发用户联网、禁止滥用探测例外、禁止直连宿主服务、45 秒许可到期后拒绝新连接、拒绝过期续期并停机。报告仅留在独立数据根。这里的八项属于待执行清单，不能用状态机单测代替内核实测。

下一步还要补实机代理中断、已有连接在到期后的行为、ACL/规则篡改、切网/休眠、进程强退、第二环境隔离和开机首包抓取。尚未交付 Windows 界面、文件共享/桥接、备份迁移、WireGuard、安装包、签名及真实 Mac 回归。

## 本轮结果（2026-10-20）

- 新增 Windows 测试：12 项通过，包含本机 Hyper-V 只读诊断、Windows IMAPI 创建并读取 NoCloud ISO，以及真实回环 TLS/CONNECT 接收器。其余为配置和故障状态机测试。
- TypeScript 检查通过；完整构建通过；PowerShell 脚本语法检查通过。
- 原有网络相关六个测试文件：39 项中 27 通过、12 失败。在原始 `main` 的独立源码副本执行相同测试，结果同为 27/39，失败项目一致。主要原因是 Windows 不支持原 Mac 路径的目录 fsync、测试依赖 Unix curl 路径，以及旧测试仍要求 4 秒而代码已使用 8 秒连接等待。没有为掩盖基线失败去修改 Mac 行为。
- Mac 核心文件与基线无差异；未在 Mac 上运行回归或重新打包。
- 真实 Hyper-V VM 尚未启动，不能标记 Windows 防护达到 Mac 同等实测水平。

## 源码入口

- `server/platform/contract.ts`：预览生命周期接口。
- `server/platform/windows/`：配置、NoCloud、Hyper-V、隧道、许可会话和宿主监测。
- `scripts/windows/`：Hyper-V 操作、启动介质和可审阅的功能启用脚本。
- `scripts/windows-dev.ts`：独立开发入口。
- `scripts/windows-lab.ts`：真实 VM 的本地合成实验。
- `tests/windows-platform.test.ts`、`tests/windows-fixtures.test.ts`：本轮已执行测试。

官方来源：[Hyper-V 要求](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements)、[虚拟网卡扩展 ACL](https://learn.microsoft.com/en-us/powershell/module/hyper-v/add-vmnetworkadapterextendedacl)、[NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)、[IMAPI ISO](https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-createresultimage)、[Canonical 固定镜像校验表](https://cloud-images.ubuntu.com/releases/noble/release-20261017/SHA256SUMS)。
