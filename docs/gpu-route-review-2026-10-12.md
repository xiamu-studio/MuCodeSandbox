# 软件绘图与可选 GPU 路线

2026-10-12，只核对现有代码和官方文档，没有改现有VM、安装GPU后端、下载镜像或编译浏览器。

绘图指浏览器显示文字、图片、动画时的渲染。当前受管启动器明确使用软件图形，Ubuntu VM里的网页可能观察到Mesa / llvmpipe；这不是用户主动画图才出现的信号。[Mesa说明](https://docs.mesa3d.org/drivers/llvmpipe.html)将llvmpipe定义为利用CPU的软件栅格化器。合法物理机在没有合适驱动时也可能使用软件绘图，不能据这一项推断平台必然封号。

当前驱动是Lima VZ。GPU不能靠改个名称或修改Chrome源码凭空获得；Mac负责接收画面也不代表客体Chrome使用Mac显卡。[Lima GPU文档](https://lima-vm.io/docs/config/gpu/)列出的加速后端是krunkit；[krunkit说明](https://lima-vm.io/docs/config/vmtype/krunkit/)针对Mac ARM64的GPU访问。此前“整个Linux VM都无法改善”的概括过于绝对，应限制为当前VZ / 启动配置路线。

| 选择 | 能改善什么 | 不能据此保证什么 | 当前安排 |
| --- | --- | --- | --- |
| 改用支持GPU访问的VM后端 | 可能让实际显卡参与渲染、改善性能 | 浏览器仍可能报告虚拟显卡；不能保证等同物理电脑 | 另做小型预编译GPU验证，不直接替换当前环境 |
| Mac本机浏览器 | 使用宿主真实图形栈 | 需要另验本机进程的强制出口和断线策略，不能沿用Linux防火墙结论 | 作为独立方案，未擅自切换 |
| 第三方指纹引擎 | 改变对外呈现的部分浏览器信息 | 不等于实际GPU加速，也不隐藏所有CLI系统检测 | 未接入；需要来源、授权、升级和一致性验证 |

GPU后端存在不代表现有Xvnc和Chrome配置自动加速。实际验证应确认DRM / Vulkan设备、受管普通用户可用性、浏览器真实适配器和Canvas / WebGL / WebGPU；同时重新验证renderer保护、DNS / UDP / IPv6 / 断线、启动和清理、固定桌面密度。不要用“仅换了显示名称”作为通过，也不重启已取消的大规模Chromium源码构建路线。

这是待选择和待验证的路线，不是已完成GPU功能或防封证明。
