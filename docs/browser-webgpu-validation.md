# WebGPU 实际计算与绘图验收

WebGL / WebGL2 成功不代表 WebGPU 可用。此专项保留生产浏览器的启动配置，在本机 Chrome 对照和 Linux VM 中使用相同测试脚本。无 Claude 账号、登录或付费模型调用。

## 检查内容

测试页面使用客体回环地址，保留浏览器原生安全上下文判定；不注入替代 WebGPU API，不指定备用适配器，不增加 unsafe WebGPU 参数。

页面与 DedicatedWorker 分别请求默认 GPUAdapter 和 GPUDevice，运行 WGSL 计算，将八个整数乘三加七，再从 GPU 缓冲区读回核对。绘图使用真正的渲染管线，将绿色三角形画入 64 × 64 RGBA 纹理，读回并核对绿色 / 红色像素数。重复绘制必须得到相同 SHA256，取消三角形后必须变成全红且 SHA256 不同。两个上下文的首帧像素 SHA256 必须一致。记录浏览器版本、适配器信息、特性、验证错误和意外设备丢失。

Linux 专项同时复用 Canvas2D、WebGL / WebGL2、相关进程所有已观察线程的隔离检查、15 次稳定采样、实际关闭图形隔离后的导航前拒绝、显示密码撤销和正常恢复，以及 eth0 抓包。API 不存在、默认适配器为空、计算或绘图失败，完整 WebGPU 命令必须返回非零。观察完成与能力通过分别记录。

基础计算与纹理测试不覆盖 WebGPU 画布显示；后述呈现与生命周期专项另测真实画布。新增三类 Worker 计算 / 纹理与候选四阶段实测通过，详见 [Worker 专项](browser-webgpu-worker-validation.md)；后续三类 Worker 的真实离屏画布显示及绘图期间原生线程保护采样也通过，详见 [新增专项](browser-webgpu-worker-canvas-validation.md)。所有 shader / 特性、强制设备丢失恢复、长期运行、真实硬件加速、Mac 设备特征与账户结果仍未完成。软件 GL / WebGL 成功不说明 Dawn WebGPU 后端具有可用设备。

## 运行

```sh
npm run test:browser-webgpu-host
node scripts/verify-webgpu-host.ts --presentation
npm run test:browser-webgpu
npm run test:browser-webgpu-diagnostic
node scripts/verify-browser-gpu.ts --webgpu-diagnostic --dawn-blocklist
npm run test:browser-webgpu-lifecycle
npm run test:browser-webgpu-presentation
MU_PACKAGED_APP=release/webgl-canvas-candidate/mac-arm64/MuCodeSandbox.app node scripts/verify-browser-gpu.ts --production --webgpu --packaged
```

分别生成 `browser-webgpu-host.json`、`browser-webgpu-production.json`、`browser-webgpu-diagnostic.json` 与带 `-packaged` 后缀的报告。诊断模式仅在自己的临时 VM 安装 Mesa Vulkan 驱动，分别比较仅安装驱动、启用 Vulkan、ANGLE Vulkan 三种配置；不改变仓库生产启动器，不添加 unsafe WebGPU 参数，不关闭任何 sandbox。运行包内服务不等于操作 Electron 界面。Linux 报告另保存实测源码副本、指纹、网络文件与截图；会清理自己的临时 VM，测量中断时停止并保留诊断数据。

## 本机对照

2026-10-10 00:46:58 至 00:46:59 UTC，普通 Mac Chrome 155.0.8059.40 的独立临时资料测试通过。默认适配器为 Apple / Metal 3，页面与 DedicatedWorker 都读回 `[10,13,16,19,22,25,28,31]`，三角形为 968 个绿色像素、3128 个红色像素，重复与两个上下文首帧 SHA256 均为 `6410233814c8df636357153fd1964f503b3674cc74af00d7cabce008fa2a2299`，取消绘图后全红，未发现验证错误或意外设备丢失。此结果证明测试脚本在一个实际支持的环境能够完成操作，不能转移为 Linux VM 已支持或本机网络已受管。

## 当前生产 VM

2026-10-10 00:42:39 至 00:45:31 UTC 的 `browser-webgpu-production.json` 完成测量，完整验收 passed=false。页面和 DedicatedWorker 都处于安全上下文、navigator.gpu 存在，但默认 requestAdapter 返回 null，因此没有执行 WebGPU 计算或绘图。CDP featureStatus 同时显示 webgpu=enabled，说明该状态不能作为实际能力证明。驱动清单中有 libvulkan1，但尚无 mesa-vulkan-drivers。

本次原样生产 WebGL / WebGL2 与 15 次图形进程保护采样通过，故障拒绝 / 密码撤销 / 正常恢复通过；物理出站 113,984 字节，批准代理 515 包、未批准 0，SHA256 为 `84d92aeeb36a2ee56930d2e6a8d998562cd07f6b1b50a2fbbddaaa2a23dc60b8`，自有 VM / 数据清理。这是当前配置缺少实际 WebGPU 设备的证据，不能称为 WebGPU 通过。报告包含当时准确源码副本；随后加强了宿主侧原始计算值与像素对照的复核，不能把旧运行说成已经执行新版复核器。

## Vulkan 驱动与后端对照

`browser-webgpu-diagnostic.json` 于 2026-10-10 00:46:57 至 00:50:38 UTC 完成，完整 WebGPU 门禁失败。实际安装 Mesa Vulkan 25.2.8 后，下面三种配置的页面和 DedicatedWorker 仍都没有默认适配器：

| 配置 | WebGL / WebGL2 | 图形隔离 | 实际 WebGPU |
| --- | --- | --- | --- |
| 仅新增 Vulkan 驱动，原 GL 后端 | 通过 | 12 个已观察线程 seccomp=2，15 次稳定采样通过 | 默认适配器为空 |
| 新驱动 + Vulkan 特性，原 GL 后端 | 通过 | 15 个已观察线程 seccomp=2，15 次稳定采样通过 | 默认适配器为空 |
| 新驱动 + ANGLE Vulkan 后端 | 能绘制 | sandboxed=false，17 个线程 seccomp=0，拒绝采用 | 默认适配器为空 |

三个配置均未观察到图形崩溃；正常配置恢复、真实关闭 GPU sandbox 后的导航前拒绝 / 显示密码撤销通过。物理抓包 173,116 字节，批准代理 638 包、未批准 0，SHA256 `dc2dff339df3e763718ebe1479db074795e3883301d531df85a2c0e62ebfc18b`，自有 VM 清理。截图已查看。没有将 ANGLE Vulkan 的绘图成功当作防护通过，没有把实验配置写入生产启动器。

固定版本源码的 [WebGPU blocklist](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/gpu/config/webgpu_blocklist_impl.cc) 将 CPUAdapter 列入限制；[WebGPU decoder](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/gpu/command_buffer/service/webgpu_decoder_impl.cc) 的 WebGPU 限制独立于 GL 的 ignore-gpu-blocklist，提供单独的 adapter_blocklist 切换。后续 `--dawn-blocklist` 对照仅在自有临时 VM 放开这项兼容性限制，仍保留 WebGPU 的其他校验及 Chromium sandbox；不用 enable-unsafe-webgpu / unsafe SwiftShader。此模式单独生成 `browser-webgpu-dawn-diagnostic.json`，即使计算与绘图通过，也只证明该实验配置，不能直接作为已支持、符合全部标准或适合生产的证明。

## 软件 WebGPU 候选实测

`browser-webgpu-dawn-diagnostic.json` 于 2026-10-10 00:51:17 至 00:55:24 UTC 完成，候选实验门禁通过。只放开 adapter_blocklist 仍没有默认设备；同时加入 `--enable-features=Vulkan` 后成功。实际报告适配器为 Google / SwiftShader、isFallbackAdapter=true，不能称为 Mesa 硬件设备或 Mac GPU。没有添加 enable-unsafe-webgpu / enable-unsafe-swiftshader 参数，但确实运行了软件备用设备，不能用“未加 unsafe 参数”代替其安全性与生产适用性证明。

页面与 DedicatedWorker 计算读回均为 `[10,13,16,19,22,25,28,31]`，三角形纹理均为 968 个绿色、3128 个红色像素，首帧与重复绘制 SHA256 相同，取消绘图后全红且 SHA256 改变。两类上下文首帧 SHA256 与本机 Metal 对照相同，未观察到验证错误或设备丢失。候选的 GPU 15 个线程与 renderer 13 / 11 / 12 个线程均通过 seccomp=2、NoNewPrivs=1、零有效能力检查；CDP sandboxed=true、图形崩溃 0，15 次稳定采样通过，WebGL / WebGL2 仍通过。

三种实验合计物理抓包 191,254 字节，批准代理 635 包、未批准 0，SHA256 `1a2dcec3753dccaadb0bcff48f42403afc2a674efdcc1f609c67479eafedbf96`，自有 VM / 数据清理。故障拒绝 / 显示密码撤销及恢复使用原样生产启动器，不能写成已对这组 WebGPU 候选启动器做相同故障与重启验收。纹理为离屏 GPU 渲染与读回，截图显示的是同期 WebGL 对照，不是 WebGPU 画布呈现。

生命周期专项 `--webgpu-lifecycle` 在每次生成正常启动器后、启动服务前，仅在自有临时 VM 加入候选的两个参数，随后调用原生 startGuestBrowser 的逐线程隔离检查。覆盖首次受测启动、浏览器重开、真实 VM 重启及关闭图形 sandbox 后的候选恢复，四次系统服务 InvocationID 必须不同；重启前后的 Linux boot_id 必须改变。任一阶段计算 / 纹理 / 画布 / 截图 / 正常退出 / 隔离失败，整体返回非零。不会把后台界面配置或浏览器资料重开当作 VM 重启，也不修改生产启动器源码。

画布专项使用 GPUCanvasContext.configure、浏览器原生推荐格式、统一参数的三角形渲染及实际 getCurrentTexture 读回。首次与重复像素相同，移动后三角形像素 SHA256 改变。另保存首帧 / 移动后的浏览器 PNG 截图，解码截图中的真实画布区域，核对红 / 绿像素数量和纹理比例，必须非空且前后截图不同。并不是把纹理像素复制到 Canvas2D 假装 WebGPU 显示。每次浏览器关闭与 VM 重启均重新申请设备。

物理抓包分重启前和重启后两段，各自必须有公开 HTTPS 经批准代理的正向对照，检查未批准输出；开始于 VM 已运行且组件安装完毕后，不覆盖首次开机或重启中的全部网络输出。管理器退出保护和首次开机另有专项证据，不能移作本轮候选证据。

2026-10-10 01:00:05 至 01:00:06 UTC 的 `browser-webgpu-host-presentation.json` 在普通 Mac Chrome 155.0.8059.40 独立资料中通过。真实画布格式 bgra8unorm，三角形原始 64 × 64 图像为 608 个绿色 / 3488 个红色像素，重复相同，移动 SHA256 改变；未发现验证错误和意外设备丢失。实际 PNG 截图已查看，显示非空的红底绿三角形；此 Mac 对照没有执行 Linux 专项的截图区域自动像素复核，也不证明本机网络受管。

## 画布呈现失败记录

`browser-webgpu-candidate-lifecycle-before-presentation-backend.json` 于 2026-10-10 00:59:48 至 01:02:41 UTC 完成四阶段，完整候选验收失败。每阶段的页面 / DedicatedWorker 计算与纹理读回成功，原生画布 currentTexture 也读出正确三角形（rgba8unorm，608 绿 / 3488 红、重复相同且移动 SHA256 改变），但浏览器 PNG 中实际 WebGPU 画布为空白，截图检查失败。首次与重开截图已查看，没有删去实际呈现检查来换取通过。

四次启动在导航前通过生产原生保护检查，真实关闭图形 sandbox 后拒绝、显示密码撤销通过；Linux boot_id 实际改变，说明执行了 VM 重启。由于截图断言在后续完整线程采样前中断，本次不能声称每阶段 15 次稳定采样已通过。两段抓包共 147,510 字节、批准代理 678 包、未批准 0，临时 VM 清理；SHA256 分别为 `85fa04287f7d7e57cbdd1fd42d88db7c24aa0b2a7101f546ee22a02530fbab02`、`c4c5e29093edf4acedc24d15f7e8833df7525d10710aec2a688c7b8e74a5e650`。准确源文件副本及失败截图保存在同名目录。

图形日志报告 vkCreateInstance 的 VK_ERROR_INCOMPATIBLE_DRIVER、无法打开 Vulkan ICD JSON、Unable to initialize SkSurface 及读取未初始化 SharedImage。固定版本的 [GPU 预隔离钩子](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/content/common/gpu_pre_sandbox_hook_linux.cc) 只批准部分具体 ICD 名称并预载部分驱动，没有包含 Lavapipe 的 ICD 名称或 libvulkan_lvp.so。此处是源码与实际日志的关联分析，不证明所有空白原因已经定位；后端共享方式、初始化及原生画布呈现仍需实际对照。候选不能进入生产。

`--webgpu-presentation-diagnostic` 单独比较原候选、禁用 Vulkan surface、SwiftShader 与 ANGLE 共享 Vulkan、Mesa Vulkan 与 ANGLE 共享 Vulkan。记录原始纹理与截图像素，保留失败结果后继续进程 / 各线程保护检查；截图为空白时整体仍失败，允许继续采样不会降低门禁。诊断的故障 / 恢复另使用原样生产配置，不转移给候选。

2026-10-10 01:03 至 01:07:34 UTC 的 `browser-webgpu-presentation-diagnostic.json` 完成四组比较，均未通过。原候选与禁用 Vulkan surface 均正确计算与读回纹理，但实际截图的 65,536 个画布像素中红 / 绿均为 0；分别观察 18 / 16 个图形线程，15 次保护采样通过。SwiftShader 与 ANGLE 共享组没有默认适配器，在后续完整保护采样前中止；Mesa Vulkan 共享组依旧空白且图形隔离失败，不采用。抓包 203,504 字节、批准代理 723 包、未批准 0，SHA256 `a1b788f60866f84aa6c75eaa190d60998773af96e630ca06ff5869e9464ea790`，自有 VM 清理。

该历史报告的 `experimentalDawnBlocklistOverride=false` 与实际四组参数不符，是报告元数据遗漏；具体参数及当时源码副本保留，后续版本已修正。它不影响本次四组均失败的结论。后续版本也把候选启动恢复与完整绘图恢复分开，避免将启动成功写成画布恢复通过。

追加 `--swiftshader-vulkan` 会生成独立的带同名后缀报告，使用固定版本支持的 `--use-vulkan=swiftshader` 比较浏览器自带 Vulkan、禁用 surface 和 Graphite 绘图路径；不覆盖原矩阵证据。它仍是隔离诊断，须实际通过画布、WebGL 与全部已观察线程保护，才能进入候选生命周期复验。

## Graphite 原生呈现候选

2026-10-10 01:08:50 至 01:12:59 UTC 的 `browser-webgpu-presentation-diagnostic-swiftshader-vulkan.json` 三组比较中，仅同时启用 Graphite 并使用浏览器自带 SwiftShader 的组通过。页面 / DedicatedWorker 正确计算与纹理读回、Canvas2D、WebGL / WebGL2、原生 WebGPU 画布均通过。首帧与移动后的 PNG 画布区域均有 9,728 个绿色 / 55,808 个红色像素，合计 65,536；比例与原始 64 × 64 纹理一致，截图 SHA256 不同，首帧截图已实际查看。图形进程 17 个线程和 renderer 14 / 11 / 12 个线程受保护，15 次稳定采样通过，图形崩溃为 0。

该轮物理抓包 196,320 字节、批准代理 621 包、未批准 0，SHA256 `427a4af12d96ccad6a71f6c210107f522dfb04060a2d81bc955d02ae2cda341c`，自有 VM 清理。单独指定 SwiftShader Vulkan 或再禁用 surface 的两个对照没有默认 WebGPU 适配器，仍记录失败；没有将计算失败从门禁中删除。所有实验仍安装了 Mesa Vulkan 驱动，本轮没有证明可省略该依赖。

独立命令 `npm run test:browser-webgpu-evidence` 重新读取保存的准确源码副本、PNG 像素、进程 / 各线程保护与物理 pcap，结果 `evidenceVerified=true, capabilityPassed=true`。它还复核前一轮矩阵，结论为证据有效、能力失败，并明确指出旧报告参数标记遗漏；未采样的保护状态用 null 表示，不改写成通过或已经检出失效。

候选生命周期命令：

```sh
node scripts/verify-browser-gpu.ts --webgpu-lifecycle --swiftshader-vulkan --graphite-candidate
node scripts/verify-webgpu-evidence.ts --report=browser-webgpu-candidate-lifecycle-swiftshader-graphite
```

这组后端如实报告 Google / SwiftShader / fallback adapter，仍是 CPU 绘图。放开 CPU 适配器兼容性限制不等于经过所有浏览器安全与兼容性评估；已观察线程受保护也不是零漏洞证明。候选须先完成自身生命周期、媒体回归、实际包和长期稳定性，当前没有加入生产。

固定版本 blocklist 对 CPU 适配器的明确原因是“尚未完整测试或符合规范”。候选没有添加 unsafe WebGPU / SwiftShader 开关，但单独绕过这项限制仍需兼容性与安全评估，不能把“没有 unsafe 参数”当作默认官方配置等价证明。Graphite 的内部 Dawn 实例另允许仅在图形进程内部使用的实验功能；它与网页 WebGPU decoder 的校验范围不同，参见 [内部上下文源码](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/gpu/command_buffer/service/dawn_context_provider.cc)。

随后复核器加强了页面与 DedicatedWorker 的 vendor / architecture / device / description / fallback 标记与功能集合对照。四项单元测试包含设备 / 功能不一致的拒绝；使用已保留的原始生命周期数据重新复核仍通过。原测量使用当时源码，新复核使用新版检查器，两者指纹分别记录，不能说原测量已经执行了后来新增的断言。

候选媒体回归使用 `node scripts/verify-browser-media.ts --graphite-candidate`，独立生成 `browser-media-graphite-candidate.json` 与 `*-acceptance.json`；只在自己的两个临时 VM 改写启动器，保留生产配置。旧生产媒体源码副本已保存，`--audit-only` 可复核该准确历史版本；原 Worker 晚注册字体差异仍使完整门禁失败，没有将旧记录覆盖为候选记录。

## Graphite 候选生命周期实测

2026-10-10 01:13:36 至 01:18:40 UTC 的 `browser-webgpu-candidate-lifecycle-swiftshader-graphite.json` 四阶段通过：首次受测启动、浏览器重开、真实 VM 重启、关闭保护后拒绝并恢复候选。四个 InvocationID 不同，重启前后 boot_id 不同；每阶段均在导航前执行生产原生逐线程保护检查，WebGPU 计算 / 纹理 / 原生画布截图、WebGL / WebGL2、15 次保护采样和 Normal 退出通过。图形进程每阶段 17 个线程受保护；renderer 分别为 13 / 11 / 12、13 / 11 / 12、14 / 11 / 12、13 / 11 / 12 个线程，均受保护；图形崩溃 0。

关闭图形保护的真实故障被 `BROWSER_SANDBOX_FAILED` 拒绝，服务停止、显示凭据删除，目标保持 about:blank；恢复后重新通过真实画布截图与完整检查。原样生产恢复标记为 false，因为本轮恢复的是候选；`candidateStartupRecoveryVerified` 与 `candidateRenderingRecoveryVerified` 均为 true，不混用原样生产证据。

重启前 / 后抓包分别 127,314 / 137,756 字节，批准代理 380 / 309 包、未批准均 0，SHA256 分别为 `f5265a36cbfd366ce146fd6291a2b9fbc721ce3d90c189af581f96eb14c3e7f8`、`c62517dd828f8367a00de541e309e714333c388257c7af6b60728eb08dfd9967`。捕获开始于组件安装后的运行状态，仍不覆盖开机 / 重启过渡期。临时 VM / 数据已清理，准确源码与每阶段启动器、截图、pcap 保留。此结果不等于生产配置、完整媒体、所有 Worker 或实际包已通过。

随后候选两台 VM 的六阶段媒体回归完成：七类上下文的身份 / 字体就绪绘制 / 音频 / WebGL / 资料持久化与保护分项通过，批准代理 17,872 包、未批准 0；完整门禁仍失败 Worker 晚注册字体，详见 [媒体记录](browser-media-validation.md)。没有新增图形或身份失败，但这不是完整媒体已经通过的结论。下一步仍有字体内核修复、更多 WebGPU 上下文与设备恢复、包内回归和长期运行。

后续仍须全部媒体回归、更多计算与设备恢复、实际包及长期性能。通过并评估单独放开 CPU 适配器限制的影响后，才能决定是否进入生产；当前生产启动器保持原样，WebGPU 仍未支持。

新增 [实际图形进程故障验收](browser-webgpu-device-loss-validation.md) 于 02:44 UTC 完成：Mac 对照及 Linux 四阶段均收到原生设备丢失通知、拒绝旧设备并恢复新设备计算，Linux 恢复中保护通过，但三类 Worker 的原画布仍为空白。完整原地恢复失败，独立证据复核确认；本页无故障画布通过不能延伸为故障恢复已完成。

平台支持与默认适配器获取受浏览器后端、驱动和安全上下文等条件影响，参考 [Chrome 官方排查文档](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)。实际结论以本项目测量报告为准。
