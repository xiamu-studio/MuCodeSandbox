# Windows Hyper-V 开发预览

分支：`codex/windows-hyperv`。Mac 基线：`cfcb5f9263dcd02cfa725e6d9aee80b065b98aa1`（0.4.65）。

真实 Linux VM 已完成创建、启动、认证管理连接、组件安装和空白受保护基盘导出。首轮内核 8/8、扩展 DNS/持续流/故障矩阵 16/16、进程强退和双环境矩阵 7/7 通过。现有本机管理网页、终端、文件传输、Linux 浏览器、普通用户权限代理和独立 Windows 桌面预览。桌面安装包为未签名测试包，仍需预先准备基盘；快照/备份和干净机器的一键准备尚未交付，不能标为完整 Windows 版本。

## 与 Mac 隔离

Mac 的 Manager、Lima/VZ、Swift 助手、桌面入口和打包命令保持不变。Windows 使用独立 CLI、数据根、镜像和密钥。共用文件 `server/egress.ts` 只收窄了 TypeScript 参数类型；VNC 增加可传入认证流的接口，Mac 仍经原有 Unix socket 包装调用。未替换 Mac 应用，未修改 `main`，真实 Mac 回归尚未进行。

## 当前架构

每环境独立 Hyper-V VM、专属 **Private** 交换机和双向拒绝全部 IP 的网卡 ACL。不创建宿主虚拟网卡、NAT、ICS、物理桥接或自动开机。

管理通路为：Windows 控制器 → 每控制器独占的 127.0.0.1 临时端口 → 原生 AF_HYPERV 客户端 → 指定 VM GUID 的 Linux AF_VSOCK → 客体回环 SSH。SSH 私钥、固定 HostKeyAlias 和独立主机密钥负责认证；原生助手只接受明确 VM GUID，不接受通配 VM。没有宿主 shell、文件服务或普通 IP 后备通道。控制器退出时助手关闭全部连接。

实机发现现有宿主代理路由会影响普通 TCP 管理路径，因此改用 Hyper-V 专用通道，未修改用户代理设置。产品服务 GUID 首次注册需要管理员权限，不覆盖其他应用的服务项。原有管理员预览入口保留；可选普通用户入口使用下述受限权限代理，签名发布仍待完成。

业务流量在 Linux 内经过 nftables、sing-box TUN、受控 DoH 和 45 秒内核联网许可，再通过 SSH 反向转发到唯一配置的上游。网络与探测身份为专用 UID 970/971；安装规则前核验实际身份。业务 UDP/IPv6 不放行，没有直连后备路径。

生产启动先检查关闭的客体防护，再建立转发。至少两个不同接收端的有效回执一致且符合批准出口，才开放业务许可。持续检查内核规则、文件权限、路由、DNS、宿主网络和许可。异常分别尝试断开通道、撤销许可和关闭 VM；停机确认独立于 ACL 完整性。

45 秒许可存在时间窗口，不承诺瞬时断网、抵抗客体 root 完全失陷、隐藏虚拟化或保证账号不被关联。

## 组件和基盘

需要 Windows 11 专业版、Hyper-V、OpenSSH 和 Node.js 24.15.0+。本机已完成 Hyper-V 启用和重启。没有真实账号或 AI 网站测试。

使用固定摘要的 Canonical AMD64 Azure VHD 和 sing-box 1.14.3。下载支持受限并行分段、断点续传和最终整体 SHA-256。未校验文件不会作为组件发布。

导入仅在新建测试目录生成非稀疏副本，原始镜像不变。固定镜像的 Azure-only cloud-init 配置通过绑定完整源摘要、ext4 文件定位及等长前后字节校验的配方改为 NoCloud；不对其他镜像猜测偏移。该 VHD 使用 Generation 1/BIOS，没有关闭宿主或其他 VM 的 Secure Boot。Generation 2 与完整签名镜像链仍待安排。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run windows:dev -- doctor
npm run windows:dev -- download-base
npm run windows:dev -- download-tunnel
npm run windows:build-base -- <本地原始VHD> <SHA-256>
```

构建器仅创建空白 VM。初始化代理只允许读取 Ubuntu 官方包来源，之后关闭。导出前清理管理授权、客体 SSH 主机密钥和 cloud-init/机器身份，写入关闭规则并同步。离线检查已确认导出盘含隧道二进制与关闭规则，旧 SSH 主机私钥和授权文件不存在。这是本地实验基盘，尚不是完成隐私和发行审计的分发镜像。

失败的空白构建可用 `--resume-builder <旧任务config.json>` 显式继续。要求配置在本数据根内、旧任务失败、旧控制器已退出、源身份一致，且实际 VM 已关闭。不能用于用户环境迁移。

数据根默认位于用户本机 `MuCodeSandbox-WindowsPreview`，可通过 `MU_WINDOWS_DATA_DIR` 设置。配置、证书、密钥、磁盘和原始运行报告不提交 Git。

## Windows 管理预览

已提供独立的本机网页管理入口，支持新建、编辑、启动、停止、重启、操作记录和防护核验。运行环境中可打开 Linux 终端，或手动上传/下载文件并浏览交换目录。使用图形基盘的新环境支持独立 Linux Chrome 画面、网址打开、画面尺寸和手动文本剪贴板。现有 Mac Electron 入口、Lima 管理器和打包命令保持独立。Windows 桌面预览使用相同管理 API；音频、图片剪贴板、共享、快照和备份仍在适配。

先准备受保护基盘，构建器会在运行数据根写入 `protected-base.json`。在管理员 PowerShell 中执行：

```powershell
# 两个路径都应是你自己的本机目录，不要放进待提交的源文件。
$env:MU_WINDOWS_DATA_DIR='<受保护基盘与Hyper-V运行数据目录>'
$env:MU_WINDOWS_APP_DIR='<Windows管理数据库目录>'
npm run build
npm run windows:ui
```

打开命令输出的本机启动链接。服务只监听 `127.0.0.1`，启动链接建立 HttpOnly/SameSite 会话，API 同时核验会话、令牌、Host 和 Origin。不要分享启动链接。关闭控制进程会撤销其出口并停止管理中的环境；异常退出后，下一次启动先确认遗留 VM 关闭，再允许新的核验流程。

管理数据库与 Mac 数据库分开。Windows 的 32 字节主密钥使用当前用户 DPAPI 保存，代理密码仍使用 AES-GCM；不写入明文主密钥文件。目录 ACL 仅保留当前用户、SYSTEM 和管理员，命名管道锁在进程崩溃后由系统释放。`windows:ui` 是原有管理员入口；普通用户入口单独提供，见下节。

默认 CLI 与界面共用 `%LOCALAPPDATA%/MuCodeSandbox-WindowsPreview` 运行目录，管理数据库位于其中的 `app`。已有早期 `app/hyperv` 目录时沿用该目录；`MU_WINDOWS_DATA_DIR` 和 `MU_WINDOWS_APP_DIR` 可明确指定位置。图形基盘只供新建环境使用，已创建环境继续使用自己的磁盘。

终端由 Windows ConPTY 驱动固定的 OpenSSH 客户端，通过原有 Hyper-V socket 通道进入客体 `dev` 用户，不能使用 sudo。已禁用 SSH 逃逸解释器、代理转发和本地命令，避免终端输入打开宿主 shell 或增加宿主转发。一次性连接凭证绑定当前防护会话，停止或重新启动后旧凭证失效。原生终端放在独立子进程中；关闭终端或失去控制进程的 IPC 后有界退出，避免 ConPTY 读取线程使主服务无法退出。

中文输入框支持普通 Unicode 文字粘贴，不自动执行；多行粘贴要求客体终端支持括号粘贴。上传文件保存到 `/home/dev/Downloads`，单个文件最多 150 MiB，最多两个并发传输。下载、传入和导出目录只能通过客体文件描述符访问，拒绝符号链接、硬链接、跨挂载点及路径跳转；下载前检查文件版本。文件任务使用客体进程组监督器，取消时终止对应开发任务。没有持续共享宿主目录，也没有自动同步宿主剪贴板。

## 独立 Windows 桌面测试包

Windows 使用 `desktop/windows/main.cjs` 和独立打包配置。应用身份为 `local.mucodesandbox.windows.preview`，与 Mac 应用不同；根目录的 Mac Electron 入口及 `package:mac` 保持原有配置。

桌面、管理服务和 ConPTY 使用普通用户权限。管理画面启用 Chromium 沙箱、上下文隔离，关闭 Node 集成和权限请求，只允许本次精确的回环服务来源；不向画面提供宿主 Node 桥。Node 管理器是独立进程，发行包内置经固定摘要核对的官方 Node 24.15.0，启动时检查其文件摘要。正常退出必须收到停机回执并等待管理进程结束。失去桌面进程时，操作系统进程句柄监测和受保护代理分别负责结束管理会话及确认停机；这些退出路径需使用真实 VM 验收。

源码开发需要 Node 24.15.0+、当前 npm 依赖、官方 Electron 运行文件，以及 `.mu-data/tools/node-v24.15.0-win-x64.zip`。Node ZIP 的固定 SHA-256 为 `cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62`，来源是 [Node 官方分发目录](https://nodejs.org/dist/v24.15.0/)。未匹配的运行时不会打包。

```powershell
# 在普通用户 PowerShell 中使用自己的运行目录和管理数据库。
$env:MU_WINDOWS_DATA_DIR='<已有 protected-desktop-base.json 的本机运行目录>'
$env:MU_WINDOWS_APP_DIR='<独立的 Windows 管理数据库目录>'
npm run windows:desktop
npm run windows:package
```

`windows:package` 在独立临时目录整理运行依赖，生成 `release/windows-preview-<随机编号>` 中的 NSIS 安装器和 `win-unpacked`。测试包明确不签名，不探测或使用用户签名身份；Node 不依赖终端 PATH，ConPTY 使用已有 Windows AMD64 组件，避开 Electron 原生 ABI。VM、基盘、管理凭据、测试 CA、抓包和运行日志不在包内。

安装器按当前用户安装，不自动启动、不自动重启。运行中的桌面或内置 Node 会阻止安装/卸载；升级不会代替桌面结束管理进程。应用文件在同一磁盘内暂存后清理，以支持安装目录和系统临时目录分属不同磁盘。发行依赖排除测试缓存，避免其过长嵌套路径遗留在卸载暂存目录。管理数据及 Hyper-V 资源独立保留，卸载应用不会删除环境。

这个包尚不包含干净机器的一键准备流程。Hyper-V、Windows OpenSSH 和已经准备好的图形基盘仍是前提；首次或源码更新后的受保护代理安装，以及每次启动代理，都可能显示管理员确认。首次使用应沿用上述环境变量指向自己的基盘目录，或在默认运行目录准备基盘。没有基盘时不允许创建可联网环境。

```powershell
npm run windows:install-lab
npm run windows:desktop-lab
# 同一个安装包在安装后运行真实 VM 验收，再检查卸载和数据保留：
npm run windows:install-lab -- --desktop-lab --reuse-fixture '<旧 desktop-lab-编号目录>'
# 显式复用上一轮本地合成信任基盘，或测试已经安装的可执行文件：
npm run windows:desktop-lab -- --reuse-fixture '<旧 desktop-lab-编号目录>' --executable '<安装后的 Windows Preview.exe>'
```

上述实验只使用合成数据和本地 HTTPS。桌面实验单独复制并信任本地测试 CA 的基盘，生产程序没有探测覆盖开关；正常出口探测域名在实验 DNS 中仅解析到保留测试地址，由回环接收端应答。原始生产图形基盘保持原摘要。报告保存在忽略目录，记录当次源码及安装产物摘要；强退后的检查由独立管理员只读程序完成，先检查实际 Off，再启动任何新代理。

Windows 上自动化工具可能把启动器父进程作为 `.process()` 返回。强退验收从 Electron 主进程读取实际 PID，再固定 Windows 进程句柄并核对可执行文件路径，确认该进程确实退出后才开始 VM 检查；报告同时保留启动器与实际主进程身份。早期误杀启动器的失败记录未改写为通过。

安装器验收与 NSIS 升级流程一样，核对并复制卸载程序到安装目录之外，使用 `_?=` 显式指定安装目录后等待其实际退出；验证应用、登记表和同盘暂存目录均已消失，独立用户数据仍在。控制面板入口、交互式向导和跨版本升级仍需第二台机器验收。

本轮桌面实机矩阵 10/10，覆盖生产探测、本机转发、真实 ConPTY、二进制往返、Linux 浏览器画面及三种退出路径；强制结束实际 Electron 主进程后约 1.7 秒独立确认 VM Off。安装器另有 5/5 检查。排除发布依赖中的测试缓存后，最终包的 5,667 个运行文件与实机受测包逐字节一致，应用程序摘要也相同；最终包再次完成安装、同版本重复安装和卸载。报告和原始失败记录只保存在本机。

## 可选普通用户权限代理

在普通用户 PowerShell 中执行；安装及每次启动代理时会出现 UAC 确认，不自动重启、不注册开机服务，也不将用户加入 Hyper-V 管理员组。

```powershell
$env:MU_WINDOWS_DATA_DIR='<已有空白基盘指针的本机运行目录>'
$env:MU_WINDOWS_APP_DIR='<新的普通用户管理数据库目录>'
npm run windows:broker-install
npm run windows:broker-ui
```

界面、Node 控制器、数据库、代理转发和终端以普通用户运行。提权组件只接受固定的虚拟机操作，不接受脚本、命令、输出目录或任意宿主文件写入。随机命名管道同时检查连接进程 PID、当前用户 SID 和已持有的控制器进程句柄；同一用户的其他进程也不能代替控制器调用。每个用户只运行一个代理会话。

代理与专用通道组件安装到 `%ProgramData%/MuCodeSandbox-HyperVBroker-v1/bin`，文件名绑定实际二进制摘要，普通用户只有读取/执行权限。代理核验安装位置、所有者、写权限、重解析点及摘要；嵌入的固定 PowerShell 脚本在受保护目录执行。构建配方摘要由运行中的代理返回，当前源码改变后必须重新安装。此预览尚无发行签名，摘要校验不能代替正式签名和可信分发。

实际虚拟磁盘、基盘缓存及 VM GUID 登记表位于该目录下按 SID 分开的管理员专用存储。用户选择的镜像/种子先使用普通控制器的访问令牌打开，再从已锁定的文件句柄复制并校验摘要；代理不能替用户读取其无权访问的受保护源文件。导入拒绝带父盘引用的差分盘及虚拟容量超过请求分配的镜像。普通应用无法直接打开或修改实际虚拟磁盘。资源与输入大小有界；容量预留、并发压力和失败回收仍须完整验收。

代理只管理自身登记的 VM GUID。控制器强退后关闭通道并尝试独立 Hyper-V 停机；正常关闭同样检查 Off。新会话有界等待前一代理释放存储锁，先停止已登记的遗留 VM，再提供请求服务。真实强退实验使用另一个只读管理员检查程序确认 Off，没有靠启动新代理的恢复流程代替强退后的证据。

该入口不能自动接管旧管理员入口创建的 VM。旧环境迁移、登记表丢失后的资源接管、共享基盘缓存清理和基盘导出尚未实现；基盘构建继续使用独立管理员构建器。请保留原有数据，在新管理数据库中验收，勿把本阶段视为权限代理已完整产品化。

```powershell
npm run windows:broker-lab
npm run windows:broker-security-lab
npm run windows:broker-owner-lab
npm run windows:recovery-lab -- --interactive
npm run windows:service-lab -- <空白受保护基盘.vhdx> <SHA-256> --broker
npm run windows:browser-lab -- --broker --interactive
```

普通用户实机基础矩阵 7 项、权限负向矩阵 8 组、控制器强退 2 项、管理 API/终端/文件 9 项和浏览器 12 项已通过；只使用本地合成测试服务。测试记录包含源码摘要，磁盘、密钥、报告和一次性启动链接均不提交。

### 创建恢复与删除

磁盘导入前先保存受保护的分配记录，源文件读取失败和取消操作也保留可检查、可删除的记录。启动恢复会实际查询 Hyper-V 并确认停机，查询失败不会解释为资源不存在。对从未完成创建的环境，重新启动可以清理未完成的分配并重试；曾经完成创建的环境只恢复原 VM GUID 和运行清单，不重建原磁盘。管理密钥缺失、身份/磁盘路径改变或已存在环境防护异常时保留数据并报错。

停止环境后可选择“删除环境”，输入完整环境名称确认。删除任务先独立确认原 VM 关闭，再移除该 VM 和专属 Private 交换机，拒绝仍被其他 VM 使用的交换机；随后清理管理员保护的磁盘目录及普通用户的管理文件。失败时保留环境记录供重试，删除开始后不提供中途取消。只有后端清理成功后才删除管理数据库中的环境。

管理文件清理使用普通用户令牌，固定目标及父目录句柄，先检查完整树，拒绝重解析点和未知文件，只逐个删除文件与空目录，不递归跟随目录联接。登记表没有对应记录时，还会检查实际 VM 名称、清单 GUID、交换机和受保护存储；发现未登记资源则保留文件，不自动接管或删除。实际虚拟磁盘和交换机删除仅针对受保护登记表中的身份，调用者不能指定输出或清理路径。

恢复与删除实机矩阵已通过 14 项检查：注入取消导入和创建回执丢失，删除本地清单后核查原盘中文文件保留，并用第二个持续运行的环境检查删除隔离。另一个只读管理员检查程序核查 VM GUID、交换机和磁盘目录实际消失。交互查看信息位于忽略目录 `.mu-data/windows-run/recovery-lab-view.json`，通过本地界面删除指定测试环境后脚本继续检查，无需伪造完成标记。新建环境默认分配 32 GiB 磁盘，与当前图形基盘匹配。

## 图形基盘与浏览器

```powershell
npm run windows:build-base -- <本地原始VHD> <SHA-256> --desktop
npm run windows:ui
```

构建器另外生成 `protected-desktop-base.json`，管理页优先使用它创建新环境。Windows 使用独立 AMD64 Chrome 155.0.8059.84 和 TurboVNC 3.3.1 目录；Mac ARM64 目录及版本目录保持独立。Chrome 摘要已对照 Google 的签名 Release/Packages 元数据核验，主签名指纹为 `EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796`；TurboVNC 同时核验官方归档摘要和提取后的服务端二进制摘要。只提取受核验的组件和许可，不执行厂商 DEB 安装脚本。

安装阶段的软件源代理只允许读取 Ubuntu 官方来源。无地址的隔离网卡会让 glibc `AI_ADDRCONFIG` 排除回环地址，因此安装脚本临时创建带 host 作用域地址的 dummy 接口，使 APT 可以连接回环代理。该接口无对端、无默认路由，脚本退出时移除；实机已检查工作 VM 中不存在该接口。APT 刷新失败会停止构建，不继续使用旧索引冒充成功。导出前检查 XKB、字体相关依赖以及浏览器/显示组件。

VNC 和 CDP 通过固定目标的 SSH stdio 流进入客体回环端口，Windows 上没有新增 VNC/CDP 监听端口。画面 WebSocket 同时核验本机会话、来源和一次性凭证，并绑定当前联网会话。Chrome 以 `dev` 运行，启动后检查渲染器与 GPU 的 seccomp、NoNewPrivileges、能力和命名空间，检查通过后才允许导航。每次启动使用空白页，语言、时区、屏幕和像素密度来自真实 Linux 进程及显示服务。浏览器操作期间继续续期和检查联网许可；子进程防护失败触发停机。

图形验收命令为 `npm run windows:browser-lab -- --interactive`，会创建全新的空白 VM 并使用本地测试页。运行数据、测试 CA/NSS 数据库、截图和一次性启动链接均保存在受限的忽略目录中，不提交 Git。交互模式输出的本地查看信息位于 `.mu-data/windows-run/browser-lab-view.json`；完成画面和中文粘贴操作后，在其中 `marker` 指定的位置写入标记，脚本会核查实际客体文字，再执行故障与停机检查。

当前已通过 65 项 Windows 本地测试、18 项共享显示/沙箱检查及 12 项真实浏览器验收：双本地出口、安装临时接口清理、导航前沙箱、原生语言/时区、受信任测试 CA 的 HTTPS、Canvas/Worker、真实画面尺寸、认证画面连接、浏览器上传/下载、手动中文剪贴板、故障撤销与确认停机。管理员入口及可选权限代理入口均已完成真实浏览器矩阵，报告绑定当次源码，测试期间源码未变，控制进程正常退出。

测试曾出现一次本地 DNS/代理探测中断并触发确认停机，该次原因尚未复现定位。故障诊断会先断开业务出口，再保存本地日志。长期稳定性仍需后续验收，不能用几分钟的实测代替。

组件来源：[Google Linux 签名密钥说明](https://www.google.com/linuxrepositories/)、[Google stable Release](https://dl.google.com/linux/chrome/deb/dists/stable/Release)、[TurboVNC 3.3.1](https://github.com/TurboVNC/turbovnc/releases/tag/3.3.1)。

## 验证与剩余项

### 独立包级验收

```powershell
npm run windows:packet-lab
npm run windows:verify-packets -- <运行数据根下的packet-lab任务目录>
```

需要已准备的 `protected-base.json`。普通用户控制器通过现有代理创建两个新的空白 VM；单独的诊断脚本经过 UAC 提权，仅操作本轮的 VM GUID、专属交换机和 Pktmon 会话，不加入产品权限代理的可调用操作，也不安装开机服务。已有 Pktmon 会话或筛选器时实验退出并保留原状态。

宿主按被测 VM 的唯一 MAC 采集；另一个空白 VM 临时接入同一 Private 交换机，使用原始以太网套接字独立接收，交换机没有宿主端口或物理上联。两端均在被测 VM 开机前就绪。实测启动 DHCP 包在宿主被拒绝，接收端没有收到启动 IPv4/IPv6。之后直接注入绕过客体 IP 防火墙的 IPv4/IPv6 TCP、UDP、ICMP 帧，目标使用虚拟链路地址和文档保留地址，没有访问真实 LAN 或 AI 服务。

核验前、业务许可开放时、恢复规则后三个阶段的 54 个带独立标识的 IP 帧，均在宿主丢弃记录中找到，接收端为零。业务许可开放时，本地 HTTPS 和受控 DoH 继续正常工作。允许对照先撤销业务许可和上游通道，只在这个无上联的实验交换机内临时移除被测 VM 的 IP ACL，接收端随即收到全部 21 个对照帧；恢复 ACL 后再次阻断。对照完成后恢复独立拓扑并删除本轮 VM，宿主网络指纹保持一致。

本机 Pktmon 文件模式曾出现计数与输出不一致，验收固定使用 32 MiB 内存缓冲。诊断器保存独立 ETW 会话身份，停止前核验身份和自身筛选器；宿主 ETW 丢失计数及接收端套接字丢失计数必须为零。采集及转换在固定句柄保护的管理员目录完成，结束后才归还用户权限。原始 ETL、PCAP、接口元数据和报告仅保存在本机忽略目录，不提交 Git。

10 项实机检查通过，独立解码器另外检查了 546 个实际记录的测试帧，核查 IP 及传输层校验和。日志包含同一包在多个组件的快照，快照数不等于送达数量；送达与否由接收端 PCAP 及逐包标识共同核验。原始数据和生产者源码摘要记录在任务目录，离线校验另保存输入文件及校验器摘要。

此实验验证当前镜像与 Hyper-V 配置的启动/原始出站边界；真实网络切换、睡眠唤醒及其他 Windows 机器仍须单独验收。

参考：[Microsoft Pktmon](https://learn.microsoft.com/en-us/windows-server/networking/technologies/pktmon/pktmon-syntax)、[ETW 会话属性](https://learn.microsoft.com/en-us/windows/desktop/ETW/event-trace-properties)、[pcapng 格式](https://datatracker.ietf.org/doc/draft-ietf-opsawg-pcapng/)、[Internet 校验和](https://www.rfc-editor.org/info/rfc1071/)。

```powershell
npm run test:windows
npm run build
npm run windows:lab -- <空白受保护基盘.vhdx> <SHA-256>
npm run windows:service-lab -- <空白受保护基盘.vhdx> <SHA-256>
```

`--ignore-scripts` 可用于当前 Node 源码预览；Windows 终端使用依赖中已有的 ConPTY 预构建组件。独立桌面使用内置 Node 运行 ConPTY；正式签名、跨版本升级和干净机器准备仍须另行验收。

首轮真实 Hyper-V 8/8：核验前拒绝业务、双本地 HTTPS 回执批准、受管 TCP、禁止滥用探测例外、禁止直连宿主、45 秒到期后拒绝新连接、拒绝过期续期、异常后确认 VM 停止。实验代理只映射保留测试地址到本机回环服务，其他目标拒绝。

扩展实测已通过 DNS、已建立流、代理/DNS 失败、规则/路由/Hyper-V ACL 篡改。另已通过控制进程强退、同一运行时双环境独立转发和许可、独立文件和身份、A 故障后 B 继续正常使用。管理 API 实机实验扩展为 9 项，在原有 5 项基础上增加 ConPTY 的 dev/无 sudo/中文/PTY 尺寸验证、二进制文件与中文文件名往返、目录/链接/版本边界、取消后的进程组回收，并检查停机时终端撤销。原生组件另有本机正常退出、强制停止和控制进程强退的回收检查。

浏览器界面操作检查使用合成后端，覆盖中文粘贴、上传和下载，不替代真实 VM 实验。旧的宿主 Python 文件往返测试在 Windows 上失败，原始 `main` 的独立副本同样失败；共享文件实现只调整运行时类型边界，其 Linux 实际行为通过 Hyper-V 客体验证。没有为旧测试修改 Mac 文件处理行为；真实 Mac 回归仍待安排。

真实切网/睡眠、完整日常功能、干净安装及跨机器包级回归仍须单独验收，不能由单测代替。例行关闭先断开出口，再限时同步客体磁盘并确认 Hyper-V 状态 Off；同步失败不能阻止强制停机。

原有六组网络测试在 Windows 上为 27/39，原始 `main` 独立副本同为 27/39，失败项目一致，涉及 Unix curl 路径、目录 fsync 和旧的 4 秒超时断言。没有为掩盖这些基线失败修改 Mac 行为；真实 Mac 回归未进行。

完整剩余工作见 [Windows 工作清单](windows-work-plan.md)。

补充回归记录：`tests/guest-display.test.ts` 的旧 Unix socket 接收端在这台 Windows 上触发 Node 原生断言退出；原始 `main` 文件副本同样在前三项通过后退出，未把它计入已通过的共享检查。没有为通过该测试改写 Mac 的 socket 行为。Windows 实际 VNC 通过认证管理流完成实机验收。

官方参考：[Hyper-V sockets](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)、[网卡 ACL](https://learn.microsoft.com/en-us/powershell/module/hyper-v/add-vmnetworkadapterextendedacl)、[NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)、[Canonical 校验表](https://cloud-images.ubuntu.com/releases/noble/release-20261017/SHA256SUMS)。
