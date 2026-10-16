# Worker 画布与运算中保护验证

日期：2026-10-10。独立候选测试，不使用 Claude 账户或付费模型；生产启动器和安装包未改变。

## 实际测试

页面创建三个真实 DOM canvas，并用 transferControlToOffscreen 将控制权分别交给 DedicatedWorker、SharedWorker 和 ServiceWorker。各 Worker 自己创建 WebGPU 上下文、管线和设备，绘制红底绿三角形，并读取 currentTexture 像素。截图必须在三个对应区域内显示正确红 / 绿像素，每个区域在移动后都必须改变像素指纹。

显示不经过 Canvas2D 复制纹理来伪装 WebGPU 画面。Canvas2D 只用于独立解码已有 PNG 的像素证据。三类 Worker 都持续执行约 12 秒 GPU 渲染与读回；循环期间保留五次进度、内核各线程状态与图形进程检查。Tracing 记录每个 Worker 的实际绘图事件、实例 UUID、进程 / 线程和时间戳；要求实际绘图事件位于检查窗口内，进度增长，并与所有采样中的同一受保护 renderer 线程对应。

Linux 浏览器的 Tracing 报告外部进程号和隔离空间中的线程号，管理接口的 /proc 则报告外部线程号。新版通过内核 task/status 的 NSpid 读取对应关系，第一项必须等于被读的外部线程号、最后一项必须等于绘图事件线程号。同一 renderer 中三种 Worker 必须对应三个不同线程，所有可见相关线程须受保护。它仍是五次采样，不保证采样之间瞬时覆盖，也不抵抗客体 root 控制内核。

候选检查四阶段：首次受测启动、浏览器重开、真实 VM 重启，以及实际关闭 GPU 保护被拒绝后的正常恢复。原生页面画布、WebGL / WebGL2、其他线程稳定性、正常退出和物理出口抓包也继续检查。

## 命令

```sh
node scripts/verify-webgpu-host.ts --worker-canvases
node scripts/verify-browser-gpu.ts --webgpu-lifecycle --swiftshader-vulkan --graphite-candidate --worker-canvases
node scripts/verify-webgpu-evidence.ts --report=browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases
```

## 当前证据

Mac Chrome 155.0.8059.40 于 02:04:27 至 02:04:42 UTC 的独立对照通过。三类 Worker 正确读取三角形原始像素，每个实际 128 × 128 截图区域有 2,432 绿 / 13,952 红，移动后三个区域指纹分别改变；持续绘图分别 168 / 169 / 169 帧。截图已查看，准确源码已归档；此对照未读取 Mac 内核线程防护，不作宿主网络保护结论。

第一轮 Linux 四阶段的 Worker 画布均成功，但运算中线程关联门禁全部失败：例如 Tracing TID 16 / 17 / 18 与 /proc 的 5407 / 5408 / 5409 属于不同编号视角，当时未记录内核对应关系。不能据此补写历史 Worker 关联通过。原报告和准确源码保留为 `*-before-thread-namespace*`；其独立复核证据有效、能力失败。首个复核还遇到解码窗口宽 1 像素的差异，原失败证据保留为 `*-decoder-size-failure-evidence.json`，修正后按实际 PNG 和记录比例恢复视口，重新核对每区域真实像素与指纹。

新增负向测试拒绝未保护线程、不相干进程 / 线程、停滞进度、绘图结束后的采样、空白或单一区域不移动，以及缺失或伪造的内核编号映射。完整自动测试 101 项通过，构建通过。

## Linux 最终复测

`browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts-worker-canvases.json` 于 02:14:22 至 02:20:40 UTC 完成，四阶段全部通过。每个阶段的三块真实画布均显示 2,432 绿 / 13,952 红像素，移动后三块区域的像素指纹都改变；原生页面画布与 WebGL / WebGL2 也通过。截图已实际查看，没有通过复制纹理代替真实呈现。

| 阶段 | 三类 Worker 各自的连续绘图帧数 | 绘图期间原生保护采样 | Worker 画布 / 线程对应 |
| --- | --- | --- | --- |
| 首次受测启动 | 165 / 165 / 165 | 5 次 | 通过 |
| 浏览器重开 | 164 / 164 / 164 | 5 次 | 通过 |
| 实际 VM 重启 | 163 / 163 / 163 | 5 次 | 通过 |
| 真实保护故障被拒绝后的恢复 | 164 / 164 / 164 | 5 次 | 通过 |

共完成 1,968 帧实际 GPU 渲染与纹理读回，20 次绘图期间采样。每次观察到图形进程 20 个线程受保护，相关 renderer 各线程也通过；三类 Worker 的不同绘图线程在各自阶段五次采样中均可对应。例如首次 renderer PID 5389 的 DedicatedWorker 事件 TID 16 对应内核线程 5457，实际 NSpid 为 `[5457,53,16]`；SharedWorker 与 ServiceWorker 分别对应 5458 / 17 和 5459 / 18。全部要求 seccomp=2、NoNewPrivs=1、零有效能力和 renderer PID 隔离，CDP 图形 sandbox 为真、崩溃数为零。绘图结束后另有每阶段 15 次稳定性检查；其 17 个图形线程不能替代绘图期间的 20 线程记录。

真实关闭 GPU 保护后的启动拒绝、显示密码撤销及恢复通过，VM 重启前后 boot_id 不同。两段物理抓包为 174,572 / 188,720 字节，批准代理 366 / 346 包，未批准均为 0；不覆盖 VM 开机期间的完整流量。自有临时 VM 和数据已删除。

02:21:00 至 02:21:01 UTC 的独立复核 `evidenceVerified=true, capabilityPassed=true`，重新核对九份准确源码、实际 PNG 区域像素与指纹、Worker 实例 / 类型、原始 Tracing / 内核线程映射、全部保护采样和物理 pcap。九个受测源文件与复测结束时的源码指纹一致。此前失败记录继续保留；后续设备故障实验保留独立准确源码，未改写此正常运行结果。

## 剩余范围

这只证明当前 Graphite / SwiftShader 候选的上述工作负载。尚未加入生产配置或安装包；Worker 晚注册字体仍有差异，强制设备丢失恢复、完整 shader / 特性、安全兼容性评估、长期性能、实际桌面 UI 和包内回归仍待完成。软件设备如实显示 Linux / SwiftShader，不声称具有 Mac 硬件特征或保证任何账户结果。主动销毁测试资源不等于真实设备故障验收。

随后 [实际设备故障专项](browser-webgpu-device-loss-validation.md) 已完成 Mac 对照和 Linux 四阶段：原生丢失通知、旧设备拒绝、新设备计算和恢复中保护通过，但三类 Worker 原画布空白，完整原地恢复失败。该新增失败不否定本页无设备故障的实际画布通过，也不能因普通 Mac 同样失败就将恢复差距取消。
