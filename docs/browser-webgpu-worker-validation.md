# WebGPU 三类 Worker 验证

日期：2026-10-10。继续验证实际浏览器能力，不使用 Claude 账户或付费模型。

## 检查范围

固定 Chromium 的 [GPU 接口定义](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.4/third_party/blink/renderer/modules/webgpu/gpu.idl) 对 Window 和 Worker 开放接口。实际测试不把接口存在或 CDP 的 enabled 状态当作计算成功。

复用原生 WebGPU 计算和纹理测试，在页面、DedicatedWorker、SharedWorker 的两个连接及 ServiceWorker 中分别运行。每类必须读回八个正确整数、红底绿三角形的实际像素、重复一致及变参后的不同像素。默认适配器、fallback 标记与特性集合必须一致；缺少适配器、验证错误和意外设备丢失都失败。

Worker 记录自身全局对象类型与原生 UUID。两个 SharedWorker 使用相同脚本和名称，实例 UUID 必须相同；避免把两个独立 Worker 写成共享实例。ServiceWorker 使用实际注册、激活与 MessageChannel，并由 message 事件的 waitUntil 保持异步运算。每次测量最后终止普通 Worker、关闭共享连接并注销 ServiceWorker，不使用网页 API 伪装。

Linux 候选仍是此前独立的 Graphite / SwiftShader 配置，沿用导航前保护检查、浏览器重开、实际 VM 重启、真实保护故障拒绝 / 恢复、原生页面画布截图与物理抓包。原有运行和新运行分开保存，生产启动器没有改变。

本页原始专项不证明三类 Worker 的 OffscreenCanvas 呈现、执行时各 Worker 的持续线程采样、强制设备丢失恢复或长期性能。其进程采样发生在 Worker 测量后，不能扩展为运算期间已采样。后续独立 [Worker 画布与运算中保护专项](browser-webgpu-worker-canvas-validation.md) 已实测真实画布和绘图期间五次线程采样，保留单独报告；字体缓存差异与候选安全 / 兼容性评估仍在原差距清单。

## 命令与证据

```sh
node scripts/verify-webgpu-host.ts --all-contexts
node scripts/verify-browser-gpu.ts --webgpu-lifecycle --swiftshader-vulkan --graphite-candidate --all-contexts
node scripts/verify-webgpu-evidence.ts --report=browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts
```

报告分别为 `browser-webgpu-host-all-contexts.json` 和 `browser-webgpu-candidate-lifecycle-swiftshader-graphite-all-contexts.json`。新增独立检查器复核所有 Worker 的原始计算、像素、适配器与实例，不用旧页面 / 普通 Worker 结论替代。准确源码副本和指纹随报告保存。

## 当前结果

01:51:01 至 01:51:02 UTC，普通 Mac Chrome 155.0.8059.40 的独立资料通过。页面和三类 Worker 均报告 Apple / Metal 3，正确读回 `[10,13,16,19,22,25,28,31]`；每份首帧 / 重复纹理有 968 绿、3128 红，变参后全红且指纹不同。两个共享连接实例相同。原始数据与当前准确源码已独立复核并归档；不证明宿主网络受保护。

新增拒绝缺少上下文、混合设备、错误计算、不同共享实例和错误类型的测试通过；完整自动测试 98 项通过，构建通过。

Linux 候选于 01:51:00 至 01:56:21 UTC 完成，四阶段均通过：首次受测启动、浏览器重开、不同 boot_id 的实际 VM 重启，以及关闭图形保护被拒绝后的候选恢复。四阶段共 20 份计算 / 纹理观察均通过，三类 Worker 的全局类型正确，两个共享连接确属同一实例；全部默认适配器如实报告 Google / SwiftShader / fallback。各阶段正确整数与纹理像素同上述 Mac 对照，不代表设备硬件相同。

每阶段原生页面 WebGPU 画布首帧与移动截图分别有 9,728 绿 / 55,808 红像素，首帧和移动指纹不同；截图已实际查看。每阶段图形进程 17 个线程、15 次保护采样通过，WebGL / WebGL2 与正常退出通过，采样范围仍是上述测量后的相关进程。真实保护故障的启动拒绝、显示密码撤销与恢复通过。

重启前 / 后两段物理抓包为 126,734 / 138,984 字节，批准代理 369 / 314 包、未批准 0，准确文件指纹随报告保存；不覆盖 VM 开机期间的完整流量。自有 VM 与数据已删除。01:56:35 至 01:56:36 UTC 的独立复核 `evidenceVerified=true, capabilityPassed=true`，重新解析全部 Worker 原始数据、准确源码、实际 PNG 像素、线程与 pcap，通过。

该结果推进了候选兼容性验证，未增加生产 WebGPU 开关或重新打包。随后 Worker 离屏画布与执行期间采样在独立四阶段专项通过，详见上述链接；实际设备故障和长时间运行仍需完成，已有 Worker 晚注册字体差异仍未修复。
