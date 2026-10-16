# 网页滚动流畅性优化与资源对照

2026-10-15。用户明确卡顿是网页滚动 / 拖动内容，不是拖动窗口。目标继续为更流畅的日常使用；不能把单项60fps宣称为端到端绝对流畅。

## 当前配置与实测

通过应用正常停止、保存、启动，将实际环境从4核/4GiB改为6核/6GiB；客体报告6CPU、约5.77GiB可见内存。没有重置浏览器、资料或更换线路，出口仍锁定166.88.36.199。

同一个有200张文字、渐变和阴影卡片的本地页，每轮8秒连续滚动和更新文字，三次一组。显示保持1600×1000 / DPR2。使用独立认证X显示和临时Chrome资料，不访问真实AI网站、用户资料或账号。

| 配置 | 浏览器rAF帧率中位数 |
| --- | ---: |
| 4核4GiB，原合成 | 27.1 fps |
| 6核6GiB，原合成 | 26.5 fps |
| 4核4GiB，CPU合成 | 59.9 fps |
| 6核6GiB，CPU合成 | 60.0 fps |

这说明当前样本的主瓶颈在软件GL合成路径，增加资源本身没有显著收益。生产浏览器增加`--disable-gpu-compositing`，保留llvmpipe、正常GPU/renderer沙箱和WebGL。资源提升提供多页面余量，不能把它解释为本次60fps的原因。

## 端到端边界

把同一页接上SSH/WebSocket/noVNC后，用宿主requestAnimationFrame采样真正变化的可见画布，剔除排队和同一刷新周期重复flip：同一6核6GiB/45fps/最高画质对照，原配置中位约10.6次画面更新/秒，CPU合成约15.1次/秒；浏览器rAF由10.5升至41.2fps。实际监视器扫描、人体输入到屏幕延迟未测，重负载传输仍有瓶颈，目标尚未闭合。

前几组pipeline文件中的viewer帧计数仅为原始flip调用，包含排队回调，不能当成可见帧率或用来宣称高帧率。可靠计数带有viewer.measurement字段，说明按宿主rAF观察可见画布。浏览器自身rAF统计不受此仪器修正影响。

测试过60fps服务上限、CompareFB=0、JPEG质量8、1280×800 / DPR2、Blob URL及ImageBitmap解码候选；未取得足够稳定的整体收益。生产保留45fps上限、质量9、压缩2和原分辨率，没有采用这些候选或修改noVNC依赖。

## 显示与防护证据

CPU合成候选仍有真实renderer和gpu-process；所有采样存活线程为dev、seccomp=2、NoNewPrivs=1、有效能力全0，renderer独立PID命名空间。Canvas2D/WebGL/WebGL2均读回绿色像素；实际截图中三块64CSS像素画布合计49152个绿色物理像素，验证可见呈现。各轮结束防火墙/隧道哈希不变、许可有效。35项相关后台测试通过。

4GiB空闲可用约3.5GiB；6GiB空闲可用约5.4GiB，均无OOM。Mac16GiB，交换区已用约29GiB；测试启动期有显著换页，独立空闲8秒样本换入1.8MiB/s、换出0。另一6GiB空闲样本换入8.6MiB/s、换出0。累计交换区不能当作当前每秒压力；没有替用户关闭其他Mac应用，也未继续盲加到8–12GiB。

## 真实GPU可行性

当前Lima2.2.0固定VZ，客体无/dev/dri，systemd-detect-virt为apple；本轮CPU合成优化不是物理GPU加速。

Lima当前官方资料将GPU支持列在实验krunkit后端：通过Mesa Venus Vulkan访问宿主GPU；不能直接套到当前VZ环境。已有Lima包含krunkit驱动入口，但本机未检出krunkit宿主程序。要单独验证浏览器渲染、显示传输、权限、严格联网/双回执/失效关闭以及升级恢复，不能直接替换原环境。GPU加速本身不移除虚拟化系统信息。

来源（2026-10-15读取）：https://lima-vm.io/docs/config/gpu/ 和 https://lima-vm.io/docs/config/vmtype/krunkit/ 。不把未来GPU候选当成已经交付。

## 复现与原件

- scripts/measure-local-scroll.ts、scripts/local-scroll-worker.py、scripts/local-scroll-fixture.html。
- test-results/local-scroll-performance/baseline-4cpu-4gb.json、candidate-6cpu-6gb.json、verified-6cpu-6gb-matrix45.json及verified-6cpu-6gb-60.json。
- CPU合成的实际绿色画布截图与线程读数随各份JSON保存；临时浏览器、显示和资料均已退出清理。
- 资源样本：test-results/current-resource-load/*smooth*.json；主机差分：test-results/display-performance/host-smooth-*.json。

## 安装版实际复核

0.4.45 / 6930c9423e6cdbb1 已安装，正常恢复后6核/6GiB、三份166.88.36.199回执一致，防护verified、许可有效。通过真实应用窗口打开本地测试文件、实际滚轮滚动和拖动滚动条，页面位置确实改变；已返回本地首页并删除自己的测试文件。未访问AI页面。

安装版8秒页内rAF结果（由CUA原生截图读出并在JSON明确标为人工转录）：452帧、56.4fps，帧间隔中位16.7ms、95分位16.8ms，超过50ms两次，无长任务；screen1600×1000、viewport1592×909、DPR2。它不能用于宣称最终屏幕56fps或相同幅度的人体输入延迟改善；也没有安装版旧配置的完全同窗A/B。

真实生产cgroup内4个renderer/GPU进程、51个线程均通过现有保护断言。安装包严格签名、依赖及篡改拒绝检查通过，35项相关后台测试通过。原件见test-results/smoothness-0445/installed.json、runtime-tests.log、package.log。

用户实际网页体验反馈仍待确认，端到端显示与真正GPU后端均未视作完成。

## 编码和查看器进一步定位

本轮在独立的认证显示 :97 / 临时 Chrome 资料中，解包并验证官方 TurboVNC 3.3.1 ARM64 候选。SHA-256 为 `ad2448cd80997174c47b507e058fc385716aa9bd71c04e149f8da5a98fa77a9b`，与 GitHub 官方 release 资产 digest 一致。未安装其系统包，未替换生产 :99 显示服务。

同一 3200×2000、2× 密度、质量9、压缩2、真实有头 Chrome 查看器下，多线程候选的可见画布更新为23.1、24.2、24.4次/秒，优于当前 TigerVNC 路径，但仍未达到流畅性目标。它用4个编码线程，`deferupdate=1`，并非45fps限流；部分早期 JSON 的 viewer.fpsLimit 是未使用的通用参数，应以 displayServer 为准。生产仍保留 TigerVNC。

基于上游源码测试扩大 Tight 图块上限、降低区域合并阈值、取消 LastRect 协商以停止递归切块。扩大上限约23–24次/秒，强制合并约19–24次/秒，减少递归切块约14–15次/秒；后者虽然将每轮 JPEG 图块从约1.5万个减至约1000个，却增加重传像素，整体变慢，均未采用。原件分别为 `headed-turbo-rect1m.json`、`headed-turbo-combine1.json`、`headed-turbo-no-recursive-split.json`。

查看器 CPU 采样发现，旧 Base64 字符串拼接和 imageRect 的处理占有明显时间。使用浏览器原生 Uint8Array.toBase64 后，同一类采样中两项合计从每轮约1.9–2.5秒降至0.35–0.63秒；有效调用计数与 JPEG 图块数逐个一致，确认实际进入候选路径。该结果证明此段处理开销下降，不能直接换算为屏幕帧率同比提升。当前 TigerVNC 路径的三轮可见更新为14.7、16.0、17.2次/秒，仍有编码/传输瓶颈。原件为 `headed-turbo-viewer-profile.json`、`headed-turbo-native-base64-transform.json` 和 `headed-tiger-native-base64.json`。

一次初始测试因本地页 DOM 尚未就绪失败，已补明确的就绪等待；另一次从不同 Vite 模块实例替换编码器没有进入实际查看器。原始失败及无效候选报告保留，并在 `encoding-candidate-exclusions.json` 逐项排除，不能计入性能收益。诊断之后使用与产品相同的源码转换函数。

0.4.46 仅接入原生 Base64 转换：保持原图像字节、分辨率、质量和RFB协议；普通数组及不支持原生接口的运行时继续原逻辑，不修改安装的 npm 依赖。构建时保留对应修改源码及 MPL 声明。两项字节一致性/兼容测试、构建及本地包检查通过；实际 Electron 44.7.0 / Chromium152 的独立受保护渲染器确认支持原生接口。详见 `test-results/smoothness-0446/`。

2026-10-15 12:00（台北时间）三处出口探针同时超时，没有收到异常 IP；环境按既有双回执规则断网并停止。原事件 `9f3d2c88-7b57-4c66-9909-2137261c4e69` 在正常重新核验后于12:03恢复。没有将该故障归因于某个未经证实的网络跳点，也未放宽超时或回执门槛。原事件快照见 `test-results/smoothness-0445/latest-protection-events.json`。

## 0.4.46 安装后复核

实际安装 build `a3d21c92cf347127`，保留旧包 `/Users/staff/Applications/.MuCodeSandbox-before-0.4.46.app`。通过应用正常退出/更新/重新启动原环境，没有重置资料。退出期间原保护连接失效记录仍保留，正常启动后恢复。

原生应用打开自建离线文件，文字、渐变图片和滚轮输入正常；拖动滚动条后可见第53张文档。八秒页内结果为447帧、55.8fps、中位16.7ms、95分位33.2ms、超过50ms两帧、长任务0；这是CUA截图人工转录的rAF结果，不证明最终显示55.8fps，也不作为相对0.4.45的帧率提升证据。已返回本地首页并删除自己的测试文件。

真实生产cgroup内4个renderer/GPU进程、54个线程均通过保护断言；三份新鲜166.88.36.199回执、许可有效，正常运行且无lastError。测试后空闲八秒内存可用约4.9GiB、OOM0，防火墙/隧道哈希不变；该样本不属于整个连续滚动负载。诊断显示 :97 已退出。安装原件为 `test-results/smoothness-0446/installed.json`，资源原件为 `test-results/current-resource-load/2026-10-15T04-41-50.222Z-native-frame-installed.json`。

目前目标仍未完成。下一步继续验证编码/传输的实际收益和可安全接入的多线程方案，保留原清晰度、固定桌面、输入和生命周期行为；GPU路线需另做独立环境，不能视作已交付。

## 0.4.47 多线程编码接入与本轮验收

最新状态以本节为准，前文“未完成”保留为各阶段历史。

修正诊断Xauthority生成权限后，新增相同条件的受保护同页对照：当前原生Base64查看器、6核6GiB、3200×2000 / 2×、质量9、压缩2、有头Chrome、查看宽988CSS像素。TigerVNC可见更新为14.1、15.2、16.6次/秒；TurboVNC为15.9、24.9、27.9次/秒，中位约15.2→24.9（约64%）。两组都通过错误VNC密码拒绝、缺失Xauthority拒绝、仅回环VNC和关闭X11 TCP、真实键盘输入、2×尺寸切换、重连保留本地存储与输入值。原件为 `guarded-tiger-native-current.json` 与 `guarded-turbo-native-current.json`。不外推为任意网站、物理显示器或指针到屏幕延迟保证。

新增单独的双向自动剪贴板负向检查：只使用临时显示里的自建X11剪贴板哨兵，不读写Mac剪贴板。客体哨兵未被宿主RFB发送覆盖，宿主未收到自动剪贴板事件。见 `turbo-display-clipboard-functional.json`。

### 安装与实际运行

0.4.47 / `cc71c27cd93d7f25` 已安装。正式显示服务使用未修改的官方TurboVNC 3.3.1 ARM64 Xvnc，最多4线程且不超过环境分配CPU。通过客体受控网络下载官方HTTPS归档，根所有缓存复验归档与可执行文件SHA-256，只提取Xvnc和许可证；不运行DEB安装脚本、不新增厂商服务、不安装Java运行时。重复执行保持inode，特意损坏尚未启用的新组件后可由有效缓存修复，原生产显示服务与防火墙/隧道哈希未改变。见 `display-encoder-install.json`。

升级前先通过原生界面正常停止环境，再退出、备份旧包并更新，随后启动原环境，保留资料。回滚包为 `/Users/staff/Applications/.MuCodeSandbox-before-0.4.47.app`。33项相关测试、构建、包严格签名/依赖/篡改拒绝检查和新增诊断脚本的TypeScript检查通过；本地ad-hoc包不等同Apple正式签名发行。

生产进程已实证为4线程Xvnc，固定2×桌面、VNC密码认证、双向自动剪贴板关闭、Xauthority属于dev且模式0600；拒绝nobody缺失认证文件连接，属于该进程的TCP监听只有127.0.0.1:5900。见 `test-results/smoothness-0447/display-runtime.json`。当前不再使用TigerVNC的45fps上限，不能保留该旧参数当作当前实际行为。

### 用户验收与边界

用户接管实际窗口并正常浏览后，反馈“流畅很多了”；在“现在滚动和拖动网页，是否已达到你期望的流畅程度？”的明确验收问题中，选择“已达到预期，可以收尾”。据此完成本轮原始流畅性目标；没有把仅增加核心、单项rAF或实验页帧率代替用户实际体验。

用户接管窗口后停止原生UI操作，不再执行原计划的安装版本地fixture跑分、关闭重开或显示设置动作。该fixture未被可见确认加载，不能声明这些额外安装版动作已经通过；对应基础行为已有独立会话和回归测试证据，本轮按用户实际验收收尾。自建 `/home/dev/mu-display-0447-test.html` 已删除，临时 :97 显示不存在。

后台最终复核：6核6GiB、正常运行且lastError为空；三份新鲜166.88.36.199回执一致、许可有效；6个Chrome renderer/GPU进程、85个线程通过现有保护断言。用户使用期间的八秒只读资源样本无OOM、内存可用约4.8GiB、防火墙/隧道哈希不变，不当作统一负载跑分。原件为 `test-results/smoothness-0447/installed.json` 和 `test-results/current-resource-load/2026-10-15T05-27-22.986Z-encoder-installed-live.json`。

仍是Lima VZ / Ubuntu ARM64与软件绘图，未安装GPU后端、未隐藏虚拟化信息。此项流畅性验收不关闭独立的N01公网超时或历史休眠停止确认问题，不重启用户已取消的全天、住宅线路或账号测试。
