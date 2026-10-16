# 网页字体、音频与图形进程验收

本专项使用生产 Linux 浏览器启动器、真实 Chromium 156.0.8078.4、严格透明网络和两台独立 Ubuntu ARM64 VM。设置分别为东京 / 日语与纽约 / 英语；覆盖首开、浏览器重开和 VM 重启六阶段。没有 Claude 账号或付费模型调用。

**完整媒体验收尚未通过。** WebGL / WebGL2 已有独立生产绘图与保护故障验收，先绘制后加载字体的 Worker 差异仍未解决。生产启动器在网站导航前检查所有相关线程，失败停止浏览器。普通 Mac Chrome 155.0.8059.40 也复现字体缓存行为，这证明它不是本 VM 独有的现象，但不是所有版本 / 平台都如此的证明。

历史二维完整运行为 2026-10-09 22:52:54 至 22:57:22 UTC（本地 2026-10-10），现存 `browser-media-before-software-gl.json`。两台全新用户 VM、六阶段记录 42 次字体上下文测量、24 组页面类音频对照、28 个 renderer 和 6 个图形进程，累计检查 370 个 renderer 线程和 66 个图形线程，无图形崩溃，六次关闭均 Normal。四份物理抓包批准代理 28,910 包、未批准 0，VM 清理；当时完整门禁仍失败字体与 WebGL 两项。此结论不能自动转移到新绘图配置。

最新 `browser-media.json` 于 2026-10-10 00:30:35 至 00:35:45 UTC 完成同样两台全新 VM 的六阶段：42 次字体上下文、24 组离线音频、28 个 renderer / 365 个线程、6 个图形进程 / 72 个线程全部通过相关分项检查，图形无崩溃，六次 Normal 关闭。字体就绪首次绘制和音频一致，七类上下文实际 WebGL 红色像素一致；新增的二维字体像素差异已消失。四份抓包共 4,733,914 字节、批准代理 29,697 包、未批准 0，VM / 数据清理。完整门禁 measurementCompleted=true、passed=false，唯一失败项是 lateRegisteredFontsConsistent；00:36:34 UTC 独立源码指纹 / 抓包复核保持同样结论。不是 WebGPU、实际音频硬件或完整新包桌面 UI 验收。

## Graphite 候选回归

2026-10-10 01:18:51 至 01:24:06 UTC 的 `browser-media-graphite-candidate.json` 使用独立两台新 VM，生产源码配置未改动；每次生成正常启动器后加入已经通过 WebGPU 生命周期的 Graphite / SwiftShader 参数，仍执行导航前的原生保护检查。保存每阶段真实启动器与 SHA256，CDP 确认 skia_graphite=enabled_on。安装 Mesa Vulkan 驱动，不宣称可省略该依赖。

六阶段、七类上下文的身份 / 请求头 / Canvas / 系统字体、就绪后首次绘制字体、离线音频、WebGL、资料隔离与重启持久化分项通过。28 个 renderer / 365 个线程及 6 个图形进程 / 96 个线程保护通过，图形崩溃 0，六次 Normal 退出。四份抓包共 3,615,168 字节、批准代理 17,872 包、未批准 0，自有 VM / 数据清理；准确源码副本、每阶段截图和启动器保留。

实际截图 / 回执的传统 platform 与 UA 为 Linux x86_64，Client Hints 则报告 Linux / arm / 64，客体 uname 为 aarch64。固定版本官方 [UA 实现](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/components/embedder_support/user_agent_utils.cc) 将桌面 Linux 的统一旧式 UA 平台固定为 X11; Linux x86_64，新 Client Hints 使用 GetCpuArchitecture；这是原生 Chromium 的旧字段固定行为。本项目没有将 UA 改成 Mac 或通过注入改变这些字段。此记录不等于所有设备特征已验证一致或服务不会采用自己的检测规则。

完整 `browser-media-graphite-candidate-acceptance.json` 仍为 measurementCompleted=true、passed=false，失败项仅为晚注册字体：每阶段页面 / 框架 / 新窗口更新，DedicatedWorker / SharedWorker / ServiceWorker 仍用替代字体。候选没有修复或隐藏此差异。WebGPU 自身原生画布另见 [专项记录](browser-webgpu-validation.md)，本轮七类媒体上下文没有新增 WebGPU 探针。

后续 `--audit-only` 直接重新解析四份物理抓包，核对批准代理包数与未批准 IPv4 / IPv6 为 0，读取每个保存的线程状态、字体宽度 / 像素散列和离线音频对照，再验证截图 / 启动器 SHA256。原样生产与候选分别复核，仍保持晚注册字体失败。复核器指纹另存，不能把后加的检查说成原测量当时已执行。

## 检查方式

字体由客体回环测试服务实际发送已安装的 Liberation Sans TTF，响应延迟一秒并禁止缓存。每次使用新的字体名称，记录 unloaded / loading / loaded 状态、宽度和实际字形像素 SHA256，并以真正 404 的字体作为失败对照。Chromium CSS 诊断另确认页面确实用了下载字体，报告保存源 TTF 的 SHA256。页面、DedicatedWorker、SharedWorker、ServiceWorker、同站框架、跨站框架及新窗口均实际执行。

同时保留两个不同的测试顺序：

1. 字体未加载时就用该名称绘制，下载完成后再次绘制。页面 / 框架 / 新窗口更新，但三类 Worker 的画布仍可能使用原来的替代字体。失败结果没有通过重命名原字体、修改网页 API 或伪造输出来隐藏。
2. 另一独立字体名称先完成下载和注册，再首次用于绘制。此顺序的七类上下文结果一致，404 字体不影响已加载字体；这不能代替第一种顺序的验收。

音频使用真正的 OfflineAudioContext：44100 Hz、4096 样本、单通道、三角波振荡器与压缩器。检查有限且非零的样本、重复相同参数的 SHA256 相等、改变频率后 SHA256 不同，以及页面 / 框架 / 新窗口和重启后的结果一致。Worker 不提供该 API，会明确记录不支持；本项不测试麦克风、扬声器、实时 AudioContext、设备枚举或权限。

WebGL 创建实际上下文，必须读取红色像素并检查错误；独立 3D 专项另实际编译 WebGL / WebGL2 三角形着色器、比较重复和移动后的像素。当前采用正常 sandbox 初始化、Mesa 单线程软件 GL，显式绕过软件显卡 blocklist；没有开启 unsafe SwiftShader 或关闭浏览器 sandbox。二维画布另固定软件绘制，避免页面读回像素时在不同后端之间切换；网页 API 与测试断言保持原样。不是 Mac 物理 GPU 或 WebGPU 证明，见 [图形专项](browser-gpu-validation.md)。

进程检查读取实际 `/proc` 状态、每线程状态与 PID namespace，使用执行文件确认 Chrome，再解析 Chromium 重写的进程标题。渲染进程须以 dev 运行、seccomp=2、NoNewPrivs=1、无有效能力、独立 PID namespace 且无 no-sandbox 参数。当前六阶段 renderer 与图形进程的所有已观察线程均通过 seccomp / 无提权 / 无能力检查，CDP 报告图形 sandboxed=true；图形进程没有 renderer 的独立 PID namespace，不能称为所有隔离机制完全相同。修前实际 seccomp=0 / sandboxed=false 的报告及抓包保存在 browser-media-before-graphics-hardening。独立实际故障关闭图形 sandbox 后，生产启动检查拒绝继续运行并恢复，包内已编译服务也通过，见 [图形专项](browser-gpu-validation.md)。

## 运行与结果

```sh
npm run test:browser-media
node scripts/verify-browser-media.ts --audit-only
node scripts/verify-browser-media.ts --graphite-candidate
node scripts/verify-browser-media.ts --graphite-candidate --audit-only
node scripts/diagnose-worker-fonts.ts --host-only
```

`test:browser-media` 会创建自己的临时 VM，并运行六阶段测量。`browser-media.json` 的 passed 表示测量和分项对照完成；它不是完整验收结论。最终门禁为 `browser-media-acceptance.json`，只有晚注册字体一致、离线音频、渲染进程 / 图形进程防护和 WebGL 渲染均通过才返回成功。当前门禁必须返回非零，不能用“观察完成”的绿色结果替代整个能力已完成。

`--audit-only` 重新检查现有报告、实际所测源码指纹、四份抓包大小 / SHA256、保护状态与正常关闭，再生成完整门禁结果，不启动 VM。观测器失败时不能复用旧报告来声称本轮通过。成功完成测量后会清理所有自有临时 VM 和磁盘，即使完整门禁因已确认差距仍未通过；实际测量中断则停止并保留诊断数据。

完整 Linux 测量需要 Apple Silicon Mac、Node.js 24.15+、Lima 及准备镜像 / 组件和公开 HTTPS 正向对照所需网络。Mac 对照另需已安装 Google Chrome。失败数据可通过 MU_CONTEXT_TEST_DATA 复用受信基础镜像，但仍创建新的 A / B VM，不能将复用基础镜像写成已验证第二台 Mac。

诊断脚本默认需要 `--data-dir=报告中保留的私有目录`，可指定 `--environment-id=...`，只接受本测试在 home 下的目录且必须已经存在；它正常启动 / 关闭该目录中的测试 VM，不操作用户环境。`--host-only` 只用独立 Mac Chrome 资料做字体对照，不启动 VM。Mac 和 Linux 使用的字体不同，不能直接比较各自的替代字体宽度；可比较“旧名称是否仍用替代字体”和“新名称在加载后首次使用是否成功”的行为。

## 失败记录与边界

`browser-media-before-worker-font-readiness.json` 保留首次发现实际 Worker 字体差异的失败。`browser-media-before-process-inspection.json` 保留完整六阶段的字体 / 音频观察，但没有进程检查，fullMediaConsistencyVerified=false。两个 proc 读取失败分别保留为 `browser-media-before-proc-format-fix.json` 和 `browser-media-before-proc-executable-fix.json`，对应抓包也保留；这些检测器错误不证明产品进程隔离失败或成功。加入截图后的后台标签页超时保存在 browser-media-before-foreground-capture；截图前切回受测页后，完整六阶段重新通过观察与防护检查，没有忽略截图失败。

`worker-font-diagnosis.json` 保存 Mac / Linux 对照、改变绘制顺序、重设字体、新画布、显式 FontFaceSet.load、等待和重新注册等检查，以及实际进程信息；最初对照另存 `worker-font-diagnosis-paired.json`。进程观察碰到自动停机的失败也独立保留，随后改为在浏览器仍打开的阶段读取。

2026-10-10 进一步检查固定版本 156.0.8078.4 的官方源码：[OffscreenFontSelector 实现](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/core/css/offscreen_font_selector.cc)、[其声明](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/core/css/offscreen_font_selector.h) 和 [FontSelector 基类](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/platform/fonts/font_selector.h)。Worker 的 RegisterForInvalidationCallbacks / UnregisterForInvalidationCallbacks、FontCacheInvalidated 为空，且没有重写基类空的 FontFaceInvalidated。结合实际旧名称持续使用替代字体、新名称加载后首绘成功的对照，字体失效通知缺失是明确的内核排查方向。此处是源码与运行现象的关联分析，尚没有对该固定二进制应用和验证原生补丁，不能写成已经修复。重新命名字体或注入网页脚本不能替代原始晚注册测试通过。

四份网络文件只检查物理出站批准范围与实际代理流量正向对照，抓包截取长度为 96 字节，不用于证明载荷加密。字体由客体回环服务提供，不代表公网 CDN / 字体跨域 / TLS 故障。六阶段媒体观察使用源码服务；包内图形防护有独立实测，但没有重跑新包的全部桌面 UI 流程。没有取得完整浏览器设备特征、WebGPU、真实音频硬件及不会封号的证明。

下一步须解决 Worker 晚注册字体缓存行为，再完成完整媒体门禁；WebGPU、实际音频设备与长期性能单独验收。每次修改后仍须保留正常画面、renderer / 图形 sandbox、网络批准和故障对照。
