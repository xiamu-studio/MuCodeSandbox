# WebGPU 实际图形进程故障与恢复

日期：2026-10-10。仅在独立测试资料与自有临时 VM 中执行；无 Claude 账号、登录或付费请求。生产配置与安装包未启用候选 WebGPU。

## 检查范围

页面及 DedicatedWorker、SharedWorker、ServiceWorker 各持有原生 GPUDevice 和真实画布。后台画布由实际 DOM canvas 转移，不经过 Canvas2D / ImageBitmap 复制来代替显示。四类上下文先连续绘图，再使用 Chrome 官方 [Browser.crashGpuProcess](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-crashGpuProcess) 中断测试浏览器的实际图形进程。

必须观察到图形进程 PID 改变、崩溃计数恰好从 0 增至 1，以及四个原生 device.lost 返回 unknown。主动 destroy 导致的 destroyed 不算本项故障。使用原设备继续绘图必须失败；随后在同一页面 / Worker 实例和同一画布重新申请设备、管线及缓冲区，设备实例须不同，真实首帧 / 移动 PNG 区域须有正确像素且指纹改变。

Linux 另检查故障前后各线程防护，以及恢复后连续绘图期间五次原生保护采样、真实 Tracing 与内核 NSpid 对应、相同的新图形进程和网络防护完整性。一次故意注入的崩溃单独计数，不放宽未注入实验的零崩溃要求。所有原有四阶段生命周期、WebGL、启动保护故障拒绝 / 恢复及物理出口抓包继续检查。

测试页面显式处理设备丢失；这不证明任意第三方页面会自行恢复，也不等于浏览器或 MuCodeSandbox 已具备统一自动恢复功能。硬件故障、OOM、驱动重置、多次崩溃和长期运行不在本次已验范围。

## 命令

```sh
node scripts/verify-webgpu-host.ts --device-loss
node scripts/verify-webgpu-device-loss-host-evidence.ts
node scripts/verify-browser-gpu.ts --webgpu-lifecycle --swiftshader-vulkan --graphite-candidate --device-loss
node scripts/verify-webgpu-evidence.ts --report=browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases-device-loss
```

## 初始 Mac 对照失败

普通 Mac Chrome 155.0.8059.40 的实际图形进程中断成功：计数 0→1，PID 改变，四类上下文均收到原生 unknown；旧设备 mapAsync 均以 AbortError 拒绝，四类上下文都能申请新设备并读回正确纹理。

真实截图中，页面画布重新显示 2,432 绿 / 13,952 红像素，移动指纹改变；三种 Worker 的原画布仍为空白，红 / 绿像素为 0，移动指纹不变。因此完整恢复失败，没有删去截图要求或把计算成功写成显示成功。

首次脚本另错误要求 Mac CDP 的 sandboxed 必须为 true，已将功能恢复与 Linux 原生保护检查分开。原报告及准确源码保留为 `*-before-host-scope*`。修正范围后的失败保存为 `*-before-offscreen-reset*`。随后增加真实 unconfigure 和资源释放再重新申请设备，三类 Worker 的原画布仍为空白，完整门禁继续失败；当前报告保留这次结果。

固定版本 [OffscreenCanvas 源码](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/core/offscreencanvas/offscreen_canvas.cc) 说明 GPU 通道丢失后需重建画布帧传递器，而 NotifyGpuContextLost 中显式清除的分支针对 WebGL。[GPUCanvasContext 源码](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/modules/webgpu/gpu_canvas_context.cc) 的 configure / unconfigure 会重建或释放交换缓冲。这是后续调查线索，尚不能据此断言唯一根因或原生修复已经完成。

Mac 对照的独立复核于 02:41:11 至 02:41:12 UTC 完成，准确源码与实际 PNG 区域像素核对通过，`evidenceVerified=true, capabilityPassed=false`。源数据与首帧截图已实际查看，三块后台画布确为空白。

## Linux 四阶段实际结果

`browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases-device-loss.json` 于 02:36:52 至 02:44:20 UTC 完成。`measurementCompleted=true, passed=false`；四阶段均复现同一失败，没有将失败的恢复门禁取消。

| 阶段 | 实际 GPU PID 变化 | 恢复后各上下文连续绘图帧数 | 恢复中保护 / 真实画布 |
| --- | --- | --- | --- |
| 首次受测启动 | 5284 → 5894 | 四类各 167 帧 | 保护通过，三类 Worker 画布空白 |
| 浏览器重开 | 6401 → 7040 | 四类各 170 帧 | 保护通过，三类 Worker 画布空白 |
| 实际 VM 重启 | 2094 → 2700 | 四类各 162 帧 | 保护通过，三类 Worker 画布空白 |
| 关闭保护被拒绝后的候选恢复 | 3727 → 4329 | 四类各 170 帧 | 保护通过，三类 Worker 画布空白 |

每阶段实际崩溃计数 0→1，四类上下文原设备均原生报告 unknown，旧设备绘图失败；设备重新申请、计算和纹理读回成功，同一页面 / Worker 实例未替换。共 2,676 帧恢复后的实际绘图 / 读回。故障前后的相关线程以及恢复绘图期间每阶段五次保护采样通过；每次新图形进程有 19 个受保护线程，四类绘图事件的真实 PID / 隔离 TID 与内核线程对应通过，网络防护保持 active / integrity=verified。它是采样证据，不能扩展为故障过程每个瞬间均已检查。

原生页面重新显示 2,432 绿 / 13,952 红像素且移动指纹改变，三种 Worker 的原 DOM 转移画布仍红 / 绿像素均为 0、移动指纹不变。Linux 首帧与 Mac 截图已实际查看。故障注入前，四阶段原始 Worker 画布、绘图期间保护、页面 / Worker 计算、WebGL / WebGL2 分项仍全部通过。

真实关闭保护后的拒绝与凭据撤销、实际 VM boot_id 改变及每阶段浏览器正常关闭通过。两段物理抓包为 291,449 / 287,692 字节，批准代理 600 / 378 包、未批准均 0，不包括 VM 开机期间的完整流量；临时 VM 和数据已删除。十一份准确源码、原始故障 / 新旧设备 / 线程状态、Tracing、PNG 和 pcap 已归档。

02:44:44 至 02:44:45 UTC 的独立复核 `evidenceVerified=true, capabilityPassed=false`：四阶段均确认 `deviceRecoveryVerified=false, deviceProtectionVerified=true`，重新核对准确源码、原生记录、实际截图像素、线程及抓包。新增复核器也重新审核上一轮无设备故障的四阶段画布报告，证据和能力仍通过，不把新增故障实验改写成旧正常运行失败。

新增负向检查覆盖仅主动销毁设备、GPU 进程或设备未改变、偷偷替换 Worker 实例、旧设备仍能工作、任一画布空白、恢复后未保护线程 / 不相关线程与网络失效。当前完整自动测试 103 项及构建通过。

## 后续工作

继续定位并修复原生 OffscreenCanvas 的图形通道恢复，保留当前失败样本重复验收。简单释放资源和重新申请设备尚不足以恢复原画布。完整重建画布、网页刷新或重新启动浏览器属于不同恢复范围，须单独测试并明确第三方页面和未保存任务的影响；不能把这些替代路径当作原画布原地恢复通过。修复、完整媒体、安全兼容性及包内回归通过之前，候选仍不进入生产。
