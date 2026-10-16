# Linux 图形进程隔离与启动检查

Linux 浏览器现已启用 Mesa llvmpipe 软件绘图，生产启动流程的 Canvas2D、WebGL 和 WebGL2 实际绘制及图形进程保护通过。完整浏览器媒体门禁仍须单独验收，不能把三角形测试扩展为 WebGPU、硬件加速或长期稳定性证明。此项不使用 Claude 账号或付费模型。

## 实现

生产启动器固定 `--use-gl=angle --use-angle=gl --ignore-gpu-blocklist`，并在启动前设置 `LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1 MESA_SHADER_CACHE_DISABLE=true`。安装配方升级至 4，显式安装 Mesa / EGL / GL 依赖，已有环境下次准备浏览器时更新。保持 Chromium 正常的图形初始化后 sandbox 流程；开发用户、认证 X11 / VNC、回环 CDP、透明代理和导航前隔离检查不变。

当前组合确实绕过软件显卡 blocklist，不再声称没有使用该参数。它限定到本机已测的固定 Chromium / Mesa 软件后端；没有关闭 renderer / GPU sandbox，也没有启用 unsafe SwiftShader、伪造显卡或修改网页 API。软件绘图使用 CPU，单线程配置可能降低复杂网页的 3D 性能；没有宣称与 Mac 硬件显卡相同。未来浏览器或驱动升级必须重新实测。

二维画布固定使用 `--disable-accelerated-2d-canvas`，WebGL 继续通过上述 GL 后端运行。此前启用默认 Canvas2D 加速的失败保留为 `browser-media-accelerated-canvas-font-difference.json`：页面同一字体宽度已更新，但连续读回的像素不同；三类 Worker 的已加载字体像素也与页面不同。Chromium 的 [原生读回逻辑](https://chromium.googlesource.com/chromium/src/+/fe487bfab3b23b7a107987b0a2f7b65222ae7ae0/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc) 确实允许自动切换 CPU 后端，这与该现象相符，但具体版本的结论仍以实测为准。没有改变测试页面、放宽字体像素断言或重写 Canvas API。

启动器在空白页阶段检查自己 systemd 服务所属的 cgroup，只读取指定官方 Chrome 执行文件的进程。必须实际存在 renderer 和 gpu-process，均以 dev 运行、无有效能力、NoNewPrivs=1、seccomp=2；每个存活线程也须满足这些条件。renderer 另须有独立 PID namespace。图形进程的 PID namespace 与 renderer 不同，不能称为所有机制完全相同。缺少角色、检查失败、无主线程记录或隔离关闭参数都会拒绝启动并停止服务、删除远程画面密码；目标网页仅在检查通过后打开。

此检查发生在启动阶段，不是新增了持续图形进程监测，也不是对 Chromium 所有其他进程、任意内核漏洞或宿主逃逸的完整证明。

官方依据：[软件显卡限制表](https://raw.githubusercontent.com/chromium/chromium/main/gpu/config/software_rendering_list.json)、[提前初始化隔离的实现](https://raw.githubusercontent.com/chromium/chromium/main/gpu/ipc/service/gpu_init.cc)、[SwiftShader 的适用范围与安全限制](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)。实际结论以固定 Chromium 156.0.8078.4 的本机测量为准，不能仅从 upstream 源码推断该版本行为。

## 本轮 3D 实测

`browser-mesa-diagnostic.json` 于 2026-10-10 00:08:47 至 00:12:47 UTC 完成全新 VM 的七组对照。默认软件显卡线程以及线程数 1 均可绘制但未启用图形 seccomp；提前 sandbox 的 GL 配置发生三次图形崩溃并退回无 GL。线程数 0 的正常初始化组合及再次启动均通过：真实 WebGL / WebGL2 编译着色器、读取绿色三角形 / 红色背景，相同参数像素一致，移动后变化；12 个图形线程及 renderer 各线程均受保护，15 次采样约 30 秒保持同一图形进程、无崩溃、正常关闭。物理代理 877 包、未批准 0，临时 VM 清理。此报告是候选配置诊断；其中历史 `full3DAcceptancePassed` 字段只代表候选绘图，不能当作当时生产配置或完整媒体通过。后续诊断已将候选与生产标志分开。

首轮诊断曾错误地用 `/proc/PID/environ` 证明配置传递，提前中断了后续检查；失败报告及执行版本保留为 `browser-mesa-diagnostic-before-environment-receipt`。Chromium 在 Linux 重写进程标题时搬移环境变量并清空原内存，因此该文件不能证明活动环境为空，见 [官方实现](https://raw.githubusercontent.com/chromium/chromium/main/base/process/set_process_title_linux.cc)。修正为只在启动前读取四个指定图形变量，并保留进程环境观测；仍要求实际像素和内核状态通过。

随后 `browser-gpu-production.json` 于 00:14:45 至 00:17:37 UTC 在另一全新 VM 使用未添加测试参数的生产启动器通过。WebGL / WebGL2、全部相关线程、15 次稳定采样及 Normal 关闭均通过；实际关闭 GPU sandbox 后，启动检查在空白页拒绝并撤销画面密码，恢复生产配置成功。防火墙 / 透明配置指纹未改变，绑定物理网卡的旁路失败；物理抓包 109,691 字节、批准代理 478 包、未批准 0，VM 已清理。不是长期、硬件加速或 WebGPU 验收。

随后旧 `release/webgl-candidate` 包的实际已编译服务于 00:17:56 至 00:21:06 UTC 在全新 VM 完成相同 3D / 防护故障验收，批准代理 479 包、未批准 0，VM 清理。其 CDHash 为 `cac39bd0d9547611453475cc4952ccb79789eb93`，安装配方为 3；不能将后续安装修复的结果归入该包。

最终候选为 `release/webgl-canvas-candidate/mac-arm64/MuCodeSandbox.app`，CDHash `627da4002ec1329755f3fe96bd7432299250c541`，包含配方 4、二维软件绘制和修正后的启动日志。`browser-gpu-production-packaged.json` 于 00:31:22 至 00:34:38 UTC 使用其实际已编译服务和原样生产启动器，在全新 VM 完成真实 Canvas2D / WebGL / WebGL2、15 次保护稳定采样、隔离关闭拒绝 / 密码撤销和恢复。物理代理 439 包、未批准 0，源码与包内文件 SHA256 已记录，临时 VM 清理，截图已查看。完整资源临时签名、篡改拒绝及包内依赖通过；没有操作实际 Electron UI、复跑该新包的 CLI / 快照事务或使用 Apple 开发者签名。

## 安装期间的网络服务

首轮 3D 综合媒体测试在冷安装期间自动停机，报告保留为 `browser-media-software-gl-installation-stop.json`，零个网页阶段完成，不能算媒体通过。此前服务日志和 Ubuntu 的实际 `systemd.postinst` 确认：依赖升级会执行 `systemctl try-restart systemd-networkd.service`，在短暂的路由切换时被宿主监测发现并撤销访问。该失败的物理代理 15,375 包、未批准 0；自有诊断 VM 已停止，原报告、抓包和日志保留。

配方 4 只给浏览器的 apt 安装子进程设置 `SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l`，延后自动服务重启，下一次 VM 重启加载更新后的系统服务；没有跳过网络检查、暂停监测或增加放行规则。该变量是 systemd 的 [已记录环境接口](https://github.com/systemd/systemd/blob/main/docs/ENVIRONMENT.md)，官方说明其稳定性不等同命令行接口，因此仍须在固定客体版本中验证。真实同一 VM 的正反对照已证明：带变量时网络服务 InvocationID 不变，普通重启时 ID 改变；见失败目录的 `offline-restart-control.json`。首次安装、浏览器重开和客体重启的综合结果单独记录，不能仅凭这个对照宣称完成。

## 已运行的故障对照

以下记录使用此前 `--gpu-sandbox-start-early --use-gl=disabled` 的二维生产配置，保留其原始范围。`browser-sandbox-guard.json` 于 2026-10-09 22:51:21 至 22:51:59 UTC 通过，采用当时启动器和真实严格透明网络：

- 普通 Canvas2D 实际绘制 25,600 个指定绿色像素并保留文字 / 白色背景与截图；三个 renderer 和一个图形进程通过检查。图形进程 11 个线程均 seccomp=2，六秒内三次采样保持同一进程、无图形崩溃。
- 在自有测试 VM 的启动器中故意加入关闭图形 sandbox 的参数，实际图形进程及其 11 个线程变为 seccomp=0，renderer 仍受保护。生产检查拒绝继续启动，服务停止、远程画面密码删除；故障时目标仍为 about:blank，没有网站导航。
- 恢复生产启动器后可以重新打开并正常关闭，客体网络防护和宿主预期指纹保持一致，绑定物理网卡的直接访问失败。
- 物理出站抓包 84,186 字节，批准代理流量 400 包，未批准输出 0。该文件截取长度为 96 字节，不用于证明载荷加密或真实住宅线路。
- 全部自有测试 VM 和磁盘数据已清理。

随后使用全新 VM 运行 graphics-candidate 包中实际已编译服务，`browser-sandbox-guard-packaged.json` 于 22:53:37 至 22:56:33 UTC 通过，同样完成真实二维绘制、关闭图形 sandbox 的故障拒绝、空白页检查、密码撤销与恢复。物理抓包 90,054 字节、批准代理 490 包、未批准 0；VM 已清理。22:58:42 UTC 独立复核源码 / 包内代码 SHA256、签名、每线程与三次稳定采样、截图和实际 pcap 重新解析通过。报告仍明确 full3DAcceptancePassed=false、applicationUiTested=false。

包位于 release/graphics-candidate/mac-arm64/MuCodeSandbox.app，CDHash 为 `9a3c9d0eff7b0f8182c02953848cbd2f12e17eef`。完整 deep / strict 临时签名、资源篡改拒绝与包内依赖正向对照已通过；不是 Apple 开发者签名、公证或 Network Extension 授权。此前备份包的桌面 UI / CLI / 快照任务证据保留原包范围，不能直接归入新包。

生产配置另经两台全新用户 VM 的媒体六阶段回归：28 个 renderer / 370 个线程、6 个图形进程 / 66 个线程均通过，四份物理抓包批准代理 28,910 包，未批准 0，六次正常关闭均 Normal。完整媒体门禁仍因 Worker 晚注册字体和 WebGL 返回失败，见 [媒体记录](browser-media-validation.md)。

最初后端对照保存在 `browser-gpu-before-backend-expansion.json`；增加驱动后的快速对照为 `browser-gpu-before-thread-stability-checks.json`，没有每线程和稳定性证明。完整对照为 `browser-gpu-before-production-hardening.json`，对应目录保存图像与抓包；它复用了已停止的实验 VM，不能替代全新 VM 的生产回归。当前 `browser-gpu.json` 同样是该阶段的历史报告，源码指纹对应当时所测版本。

## 运行

```sh
npm run test:browser-sandbox-guard
npm run test:browser-gpu-production
npm run test:browser-mesa-diagnostic
MU_PACKAGED_APP=release/webgl-canvas-candidate/mac-arm64/MuCodeSandbox.app node scripts/verify-browser-gpu.ts --production --packaged
node scripts/verify-browser-gpu.ts --guard-only --packaged
node scripts/verify-browser-sandbox-evidence.ts
npm run test:browser-gpu
npm run test:browser-media
```

`--production` 使用当前生产启动器，要求真实 WebGL / WebGL2、每线程保护、稳定采样和故障拒绝 / 恢复。`--guard-only` 明确切回历史二维配置，不能用它代替新生产 3D 验收。普通 GPU 命令保留旧后端对照，`--mesa-diagnostic` 增加线程 / blocklist 对照，二者都不等于原样生产配置。`--expanded` 在自有 VM 中安装 Mesa Vulkan 驱动并增加后端对照，不改变生产安装依赖。

`--packaged` 检查实际包签名、记录代码哈希并执行包内已编译服务。历史默认值为 graphics-candidate 二维包；测试新生产 3D 必须按上面的命令显式指定 webgl-canvas-candidate。测试框架仍在源码环境中运行，不能把它写成实际桌面 UI 工作流已复验。

Worker 晚注册字体差异仍须解决，完整媒体门禁单独保留结果。签名开发者账号、Mac 网络扩展、住宅线路和真实 Claude 账号不属于此项的通过范围。
