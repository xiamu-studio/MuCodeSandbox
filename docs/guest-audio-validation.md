# Linux 浏览器到 Mac 的音频输出桥接

日期：2026-10-11。此文记录设备信号方案中的真实音频输出工作。

## 当前实现与验收边界

新增的输出桥接模块、播放控件与测试已经完成，`npx tsc --noEmit` 和
`node --test tests/guest-audio.test.ts tests/guest-audio-service.test.ts` 通过
（10 项模块测试 + 2 项服务集成测试）。这些测试使用有明确
样本值的 PCM 数据与受控流，证明接入协议、样本解码、播放调度和资源撤销。
它们不证明当前日常虚拟机已经安装音频服务，也不证明 Mac 扬声器已发声。

已经接入浏览器生命周期、本地 API / WebSocket 服务和查看器声音开关。
根任务用单一隔离候选环境进行真实来宾音频输出验证。
日常越南环境没有因本模块的实现而安装包、重启或改变设置。
实际信号和本机播放的结果应分别记录于本文的验收表，不能由设备枚举结果推断。

## 信号路径

```mermaid
flowchart LR
  C[Linux 浏览器实际音频输出] --> P[来宾专用 PulseAudio 输出汇]
  P --> M[输出汇 monitor 的 PCM]
  M --> S[原有 SSH 身份验证通道]
  S --> H[本地服务 一次性票据与来源检查]
  H --> W[只发送音频的 WebSocket]
  W --> A[用户开启后的本机 AudioContext]
  A --> D[Mac 当前输出设备]
```

`module-null-sink` 是来宾内的实际音频输出汇。它的输出 monitor 被 `parec`
读取并传到本机，才形成可以播放的链路；只有 null sink 或
`enumerateDevices()` 结果不能算完整功能。没有添加宿主麦克风、摄像头、
音频输入上传或网页属性伪装。来宾 monitor 是浏览器输出的回读，未接入物理
麦克风。浏览器仍按原生权限规则管理网站的媒体权限。

## 认证、寿命与缓冲

- PulseAudio 只加载 cookie 认证的 Unix native socket，不加载 TCP native
  服务、硬件输入或 udev 自动发现模块。cookie 为 256 字节运行时随机值，
  文件权限 0600，目录 0700；配置、状态与 socket 都在
  `/run/mu-browser/audio`，随 browser service 的 RuntimeDirectory 清除。
- 播放票据由已有 Bearer API 签发，15 秒有效、仅用一次，绑定同一浏览器
  session 对象与撤销代数。WebSocket 额外校验 loopback、Host 和 Origin。
  出现来源错误、过期或防护异常时也消耗票据。
- 单个环境最多一个播放连接，防止多窗口重复播放。发票不启动 monitor
  读取；用户点击开启后，授权的 WebSocket 才启动 SSH capture。
- 双声道 48 kHz `s16le`，每包 20 ms（960 帧）并附递增序号。服务端积压
  上限约 200 ms，残留 PCM 不超过一包；超限关闭连接，不持续堆积音频。
  本机调度最多约 250 ms，初始约 60 ms 余量；无效长度、序号或过长积压
  均终止播放，避免离线回来后突然播放过期声音。
- 浏览器关闭、session 替换、防护失败、页面销毁、音频暂停或用户关闭
  开关都会撤销连接和排队的 AudioBufferSource。服务端同步 revoke 防止
  异步授权结束后接受旧 session；旧 health check 不会撤销新 session。
- 音频会话默认每 5 秒复核授权和网络完整性，避免开启出口锁定时每秒追加
  公网出口 / SSH 请求；原有防护、限时 lease 和即时撤销路径继续生效。
  这是一项周期检查，不是每个连接或每个音频包都已完成公网来源证明。
- SSH stdin EOF 使来宾 Python 包装器停止并回收 `parec`。本地等待有上限，
  不保存原始音频，不输出认证 Cookie，不改变 Mac 全局音量、输出设备或时区。

## 集成接口

`server/guest-audio.ts` 导出以下接口，现有文件由根任务统一修改：

1. 候选环境的安装阶段调用 `ensureGuestAudio(runtime, environment, options)`。
   包清单为 `pulseaudio` 与 `pulseaudio-utils`；安装使用现有代理和延迟重启
   规则，不触发重启当前网络边界。
2. 浏览器 launcher 在 Chrome 启动前执行 `GUEST_AUDIO_LAUNCHER_START`。
   launcher 的 `pulse_pid` 必须加入 cleanup 和 `wait -n`；任何必需进程退出
   都结束整组浏览器进程。browser service 不启用开机自动启动音频。
3. `GuestAudioHost` 的 `getSession` 返回 `GuestBrowserHost.entries` 中同一个
   entry；`authorize` 使用实际浏览器 / 网络授权；`capture` 调用
   `createGuestAudioCapture(runtime, session)`。
4. 新增授权 POST `/api/environments/:id/guest-audio-ticket`，返回
   `await guestAudio.issue(id)`。WS `/guest-audio` 路由调用 `upgrade`，并复用
   当前浏览器查看器的严格 Host / Origin 条件。
5. 在 `closeEntry` 的开始和 quarantine 路径调用同步 `guestAudio.revoke(id)`；
   服务关闭时执行 `dispose()`。回收要先于浏览器正常退出的等待。
6. 浏览器 toolbar 插入 `<GuestAudio id={id} connected={connection==='connected'} />`。
   默认关闭。点击内创建并 resume 本机 AudioContext，随后异步取得票据。

## 真实候选环境的验收

`INSPECT_GUEST_AUDIO_SCRIPT` 检查 browser service active、Unix socket、目录 /
cookie 权限和 `pactl` sink/source。预期只有 `mu_browser` 输出汇及其 monitor；
这只是服务结构就绪。

`GUEST_AUDIO_TEST_TONE_EXPRESSION` 在真实浏览器页面产生 2 秒、440 Hz、低增益
测试音。通过真实用户事件，或隔离测试的 CDP `userGesture:true` +
`awaitPromise:true` 运行。测试时先用授权 WS 开启 capture，再启动测试音。
`scripts/guest-audio-proof.ts` 的 `collectGuestAudioSignal` 仅在内存中计算包数、
非零样本、峰值、RMS 和频率；3.5 秒后关闭连接，只交付聚合读数，不保存 PCM。
收到非零并识别到 440 Hz，证明浏览器到本地服务的实际音频信号路径。

本机播放还必须通过真实控件开启、native AudioContext running、解码 / 排队 /
输出链路检查，以及关闭立即停止。它证明软件播放路径；如没有人听到声音，
仍要记录物理可听结果未确认。不要为测量而开启麦克风或系统回录，不修改
宿主音量或输出设备，不用模拟 AudioContext 测试替代真实本机播放。

本次 `node scripts/verify-guest-audio-ui.ts` 已通过：在 Mac 本机有窗口的 Chrome
运行真实控件，用限定本地夹具的 440 Hz PCM 验证输出图。点击前无
AudioContext / API 请求 / transport；点击后原生 AudioContext 为 running、
48 kHz、双声道，source 实际连接原生 destination，原生 analyser 读到峰值
`0.024993896484375`。关闭后 context 为 closed、排队 source 被 stop，
WebSocket 回收，页面没有错误。诊断 analyser 连接零增益观察分支，没有
麦克风或系统回录。证据是 `test-results/guest-audio/host-playback.json`。
这个结果证明本机软件播放路径，音源仍是本地夹具；真实来宾浏览器 → SSH
路径和物理扬声器可听结果仍要分别验证。

| 验收层 | 本次状态 | 证据 |
| --- | --- | --- |
| 协议 / 授权 / 清理 / 调度 | 已通过 | 模块 10 项、服务集成 2 项、TypeScript 检查 |
| 候选 PulseAudio / 浏览器实际输出 | 待统一候选验证 | 需要 sink/source 结构、浏览器音与实际非零 PCM |
| Mac 实际软件播放路径 | 已通过限定本地夹具 | 有窗口 Chrome、真实控件、原生 output graph 与实际非零 analyser 信号；来宾音源待补 |
| Mac 物理扬声器可听 | 未确认 | 不从解码、running 或输出设备枚举推断 |
| 日常环境迁移 | 未执行 | 候选验证完成后由根任务安排 |

实现依据：PulseAudio 官方[模块接口](https://wiki.freedesktop.org/www/Software/PulseAudio/Documentation/User/Modules/)、
[环境变量说明](https://wiki.freedesktop.org/www/Software/PulseAudio/FAQ/)和
[参数解析源码](https://github.com/pulseaudio/pulseaudio/blob/master/src/daemon/cmdline.c)。
`parec` 的 raw PCM、latency / process 参数按官方
[pacat 源码](https://github.com/pulseaudio/pulseaudio/blob/master/src/utils/pacat.c)核对。
