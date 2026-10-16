# 命令行客户端的系统识别与数据发送审计

日期：2026-10-11（台北时间）。检查仍在继续；本文记录五轮已验证范围。
目标是实际检查读取与发送行为，不隐藏虚拟化标记、不修改官方客户端。

## 已确认的结果

1. **客户端确实执行环境探测。** 在启动、无账号模型请求及交互场景中，
   实际尝试读取 `/sys/hypervisor/uuid`，检查 `/.dockerenv`，读取
   `/proc/version` 和 `/etc/machine-id`。关闭非必要遥测后仍有这些读取。
2. **当前 UUID 探测没有得到 Apple VM 名称。** 这台 VM 上
   `/sys/hypervisor/uuid` 返回 ENOENT。发现的源码部署识别逻辑用该值
   判断 AWS EC2，并另判 Docker / WSL 等。在所测常规路径中未观测到
   CLI 执行 `systemd-detect-virt` 或读取 Apple 产品名称那条 DMI 文件。
   不能把此有限负结果扩大为全部功能均不识别虚拟化。
3. **默认遥测包含环境类别。** 默认官方地址分支的本地接收端收到
   `platform=linux`、`arch=arm64`、Ubuntu 24.04 和
   `deployment_environment=unknown-linux`。`unknown-linux` 表示本次
   部署分类结果，不能解释成“官方判定异常用户”或“确定是物理机”。
4. **关闭非必要遥测只减少部分发送。** 对照场景中，不再出现观察到的
   `/api/event_logging/…` 和特性评估请求，但模型请求仍携带 Linux / ARM64
   请求头、内核版本、工作目录及设备 / 会话标识。不是所有信息均停止发送。
5. **授权系统查询会直接暴露虚拟化。** 本地夹具明确要求执行只读
   `systemd-detect-virt --vm`；真实 Bash 工具得到 `apple`，下一个模型请求
   的 `tool_result` 包含该输出，`is_error=false`。这不是默认偷偷执行的证据，
   而是获准执行命令后，工具结果能够携带虚拟化事实的直接证据。
6. **应用的环境清理生效。** 对照生产启动命令，以 UID 502 的 dev 用户
   和 `env -i` 启动，未继承 SSH / Lima / 本机账号环境；无 LD_PRELOAD。
   当前严格透明模式的六个代理变量存在但为空。实际 `mu-proxy-run` 包装器
   的默认 / 关闭遥测对照也完成，结果方向与直接客户端启动一致。

这些结果不证明平台据此封号，也不证明登录账户后的收集完全相同。
真实 Linux、ARM64、容器或虚拟机不是已证实的违规条件。

## 软件与身份绑定

- 当前用户“越南线路测试”环境**尚未安装 Claude Code 或 Node**。
  之前的 CLI 验收使用一次性测试环境，不能写成当前 VM 已安装。
- 审计对象为官方 npm 当前版本 **2.1.296** 的 Linux ARM64 原生执行文件。
  registry 签名、下载完整性及文件 SHA256 已检查。
- 执行文件 SHA256：`f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa`。
- 官方 npm 主包的安装器会将该原生文件复制到启动入口；另检查了安装器
  与后备启动脚本。无需为本轮运行额外安装 Node，不修改这些文件。
- 测试包压缩下载 115,122,331 字节，解压 256,434,762 字节；单平台，
  无浏览器源码、编译工具链或新 VM 镜像。审计文件留在明确的临时目录，
  总量限于 1 GiB 内；产品用户目录未安装客户端。

## 如何避免真实账号与付费请求

在现有 VM 内建立独立 mount / network namespace。仅存在回环网卡，
无默认路由，原用户 HOME 被空白临时目录遮蔽，原 DNS / IPC 路径被隔离。
原 VM 网络与防护不修改。模型由同一命名空间中的固定响应夹具模拟。

“官方地址分支”仅指客户端选择了官方主机名的代码路径：在测试命名空间
中将 api.anthropic.com / platform.claude.com / claude.ai 映射到本地接收端，
并给该测试进程提供一天有效的临时 CA，保留 TLS 校验。没有修改全局
证书库，没有访问实际官方服务器，没有真实账号、真实凭据或付费模型。
本地服务器的配置 / 策略响应不等同于真实官方响应，部分请求会因简化
响应而重试，不将重试次数作为真实使用异常或成本结论。

## 场景与独立复核

四批共 **19 条观察记录，其中 4 条是追踪校准，15 条是 CLI 场景**。

| 批次 | 已覆盖内容 | 边界 |
| --- | --- | --- |
| 本地网关 | 版本、帮助、首次交互联网失败、默认 / 关闭遥测 / 官方演示设置下的无工具请求 | 首次联网失败是测试网络有意隔离，不是产品断网故障 |
| 默认官方主机名 | 默认 / 关闭遥测 / 演示请求，首次交互启动 | 官方响应由本地夹具模拟，未做真实登录 |
| 工具与交互 | 授权 Bash 查询并回传 `apple`；首次主题页；演示设置下真实 TUI 请求及本地回复 | 主题页按观察时限结束；TUI 演示跳过首次账号设置，不代表正常登录通过 |
| 生产包装器 | 使用实际 mu-proxy-run 的默认 / 关闭遥测请求 | 临时 HOME 和隔离网络仍是审计条件 |

独立 `audit-claude-report.mjs` 核对程序摘要、每批脚本摘要、原始追踪 / 输出
摘要、回环网络、源目录遮蔽、校准成功、请求字段、遥测对照与工具回执。
`evidenceChecksPassed=true` 只表示这些证据检查通过，不是防封或隐身通过。
校准真实读取到 `Apple Virtualization Generic Platform`，说明追踪能发现
该路径；未用“没搜到关键词”代替运行观察。

## 文件与复核入口

- [实施计划](plans/2026-10-11-cli-environment-audit.md)
- `scripts/audit-claude-fetch.mjs`：取官方平台包、签名及完整性校验。
- `scripts/audit-claude-static.mjs`：版本绑定的可读代码 / 字符串线索。
- `scripts/audit-claude-guest.py`：空白资料与隔离网络中的运行追踪 / 接收端。
- `scripts/audit-claude-report.mjs`：独立复核本轮原件。
- `test-results/client-environment-audit/verified-report.json`：分项结论与文件摘要。
- 同目录 `runtime-*-final/`：原始 strace、终端输出、接收端回执及实际运行脚本。
- `test-results/client-environment-audit/protection-after.json`：原 VM 防护的事后核对。

## 第二轮：标识来源与工具拒绝规则

新增 **11 条观察记录，含 2 条校准和 9 条 CLI 场景**。与第一轮合计
30 条记录 / 6 条校准，各批仍分别绑定运行脚本、原始文件和程序摘要。

### 三种容易混淆的标识

| 字段 | 本轮确认的含义 | 验证 |
| --- | --- | --- |
| Linux `/etc/machine-id` | 操作系统的机器标识 | 追踪确认客户端读到测试中的 A / B 两个值 |
| CLI 配置 `userID` | 客户端生成并保留的 32 字节随机值，保存为 64 位十六进制文本 | 未修改程序的可读代码与五个请求回执交叉核对 |
| CLI 配置 `machineID` | 另一份独立生成并保存的随机配置标识 | 与上述 Linux 字段不同；本轮不推定所有功能都如何发送它 |

本轮 **Messages 请求 `metadata.user_id` 内的 `device_id` 等于配置 `userID`**。
同一份 CLI 资料重复启动时保持不变；仅在测试命名空间内将 Linux 机器标识
从 A 改为 B，它仍不变；相同系统标识下换空白 CLI 资料，得到另一值。
五次请求的 session_id 均不同。不能由此推定所有标识都来自同一位置，
也不能推定网站无法通过账号、线路或其他信息关联访问。

这些标识实验只改变独立 mount namespace 内的合成文件，原 VM 的
`/etc/machine-id` 没有改成测试值。没有编辑生产 CLI 配置或真实账号资料。
用户界面的“重置浏览器资料”不会清除 CLI 配置，所以不能将其称为全部
应用身份均重置。源码、回执和配置原件只保存于私有审计目录。

### 权限规则能限制什么

| 测试设置 | 实际结果 | 仍存在的范围 |
| --- | --- | --- |
| 允许 Bash，但明确拒绝 `systemd-detect-virt *` | 命令被拒绝，工具结果为错误；未读到 Apple 产品名称 | 不证明其他命令或客户端内部读取全部被阻断 |
| 本次会话禁用 Bash | 返回工具不可用，没有执行该查询 | 其他工具仍需分别限制 |
| 禁用 Bash，允许 Read | Read 读取 `/sys/class/dmi/id/product_name`，Apple 产品名称进入下一次请求 | 只禁某个命令或工具不够覆盖文件读取 |
| 允许 Read，同时拒绝 `Read(//sys/**)` | 该文件读取被拒绝，未传送 Apple 产品名称 | 不等同于整个进程无法读 `/sys` |

四个权限场景均仍观察到客户端启动尝试访问 `/sys/hypervisor/uuid`。
工具规则可以阻止所测模型工具调用，**不控制客户端自身所有文件读取**。
本轮没有把这些测试规则应用到用户的日常环境，没有修改官方客户端。

第二轮原件：`test-results/client-environment-audit/runtime-identity/`、
`runtime-permissions/`、`static/identity-generator.json`。
独立复核：`node scripts/audit-claude-identity-permissions.mjs`，结果位于
`identity-permissions-report.json`。复核按 PID 合并 strace 的 unfinished /
resumed 调用，不将并发输出的两半漏看成没有读取。

权限文档：[官方规则说明](https://code.claude.com/docs/en/permissions)。
本轮结果仅适用于实际测试的程序版本、调用和字段；第三轮补充下述
间接子进程与自建 MCP 夹具，不代表其他插件与真实登录行为已覆盖。

## 第三轮：间接子进程与已配置的本地 MCP

运行完成于 **17:36:26（台北时间）**。新增 8 条记录，含 1 条校准和
7 条 CLI 场景；三轮合计 **38 条记录 / 7 条校准 / 31 条 CLI 场景**。
使用同一未经修改的 2.1.296 原生文件和已有临时目录，没有重新下载包。

每个查询均由本地夹具明确发起并预先设置工具权限。Python / MCP 夹具
是自建的只读程序，只读取固定的 `/sys/class/dmi/id/product_name`；
不是安装真实第三方插件或证明客户端默认会执行这些查询。

| 场景 / 设置 | 实际读取和调用 | 本地接收端观察 |
| --- | --- | --- |
| 允许 Bash，拒绝 `Read(//sys/**)`，执行直接 `cat` | 拒绝该命令，没有读取产品名 | 工具错误，无 Apple 产品名称 |
| 同样拒绝 Read 路径，Bash 执行 Python 读取该文件 | UID 502 的 Python 子进程成功读取产品名 | Apple 产品名称进入下一次模型请求 |
| 拒绝 `Bash(systemd-detect-virt *)`，执行绝对路径形式 | `/usr/bin/systemd-detect-virt --vm` 仍实际执行并读取 DMI | `apple` 进入下一次模型请求 |
| 本次会话禁用全部 Bash，再要求 Python 查询 | Bash 工具不可用，Python 夹具没有启动 | 工具错误，没有读取或回传产品名 |
| 禁用 Bash、拒绝 Read 路径，但允许自建 MCP 工具 | MCP 服务启动，`tools/call` 执行，成功读取产品名 | Apple 产品名称进入下一次模型请求 |
| 禁止该 MCP 工具调用 | 服务仍启动并完成初始化 / 工具列表，未执行 `tools/call` | 工具不可用，无产品名 |
| 禁止 MCP 工具，夹具设为启动时读取 | 该 MCP 进程在初始化前读取产品名；没有工具调用 | 本轮所有接收请求的正文均未出现该产品名称 |

最后一行必须分开理解：**后台进程确实能读到**，但**本轮未观测到该值
被发送给模型接收端**。它不证明真实插件会收集或外发该值，也不证明
所有插件都安全。测试命名空间没有外网接口或默认路由，不允许夹具对外发送。

这轮说明三种控制不可混为一谈：工具拒绝规则、外接服务是否启动、
整个进程实际可读取哪些系统文件。前两种并不自动提供第三种限制。
针对一个命令写拒绝规则，也不能等同于阻止同一程序的全部调用形式。
这些范围与[官方权限说明](https://code.claude.com/docs/en/permissions)和
[官方沙箱范围](https://code.claude.com/docs/en/sandboxing)相符。

独立复核同时核对成功的内核读取、实际执行进程、MCP JSON-RPC 事件、
下一次 Messages 请求的工具结果及程序 / 夹具摘要，按 PID 合并并发追踪。
不是仅采信夹具自己的事件记录。七个 CLI 场景的内部启动探测仍尝试
访问 `/sys/hypervisor/uuid`，工具拒绝不控制这段客户端内部读取。

原件位于 `test-results/client-environment-audit/runtime-indirect/`，包含
strace、客户端输出、MCP / 子进程事件、接收回执及实际运行的两份脚本。
运行 `node scripts/audit-claude-indirect.mjs` 可独立复核，结果为
`test-results/client-environment-audit/indirect-report.json`。

17:39:37 再核对原越南环境：VM 与浏览器仍运行，防火墙、受控 DNS、
透明路径和联网许可有效，完整性 verified；见
`test-results/client-environment-audit/indirect-production-after.json`。
系统机器标识的摘要与本轮开始前一致；生产用户目录仍未安装 Claude Code。
审计进程均已退出。没有将拒绝规则、MCP 配置或测试 CA 留在日常用户环境。

实现位置：`scripts/audit-claude-platform-fixture.py`、
`scripts/audit-claude-guest.py`、`scripts/audit-claude-indirect.mjs`。

## 第四轮：已配置的启动脚本与 API 错误

运行完成于 **17:46:39（台北时间）**。新增 8 条记录，含 1 条校准和
7 条 CLI 场景；四轮合计 **46 条记录 / 8 条校准 / 38 条 CLI 场景**。
仍复用同一个原生文件、临时 HOME 和回环网络，不登录真实账号。

### 不调用模型工具，也可以经过启动脚本带入信息

本轮显式配置一个自建 `SessionStart` command hook。它只读取固定的
系统产品名称，并按官方协议返回 `additionalContext`。模型请求本身
禁用内置工具、没有 MCP，接收端也没有请求任何工具调用。

| 设置 | 读取 | 首次模型请求 |
| --- | --- | --- |
| 启用该启动 hook | UID 502 的 Python 子进程成功读取 Apple 产品名称 | 上下文包含产品名称 |
| 仍配置该 hook，另拒绝 Bash / Read | hook 仍执行并成功读取 | 同样在首次请求中出现产品名称 |
| 同一 hook 配置，CLI 设置 `disableAllHooks=true` | 本轮 hook 没有启动，没有读取产品名称 | 没有出现该产品名称 |

这是**用户配置的启动脚本**产生的读取，不是证明官方默认脚本在查询 VM。
说明“关掉模型工具”与“停止已配置的启动程序”是两回事。关闭 hook 的
负对照仅适用于本轮配置，受管策略的优先级另见
[官方 hook 说明](https://code.claude.com/docs/en/hooks)。三项均仍观察到
客户端自身启动访问 `/sys/hypervisor/uuid`，不能用关闭 hook 代替全进程限制。

### 错误、重试和诊断数据

本地接收端提供两种合成响应：持续 HTTP 400，或第一次 500 后恢复 200。
各自比较默认设置与非必要遥测关闭。

- HTTP 400：模型请求一次，CLI 退出码 1，实际输出合成错误文字。
  默认事件接收端收到 `tengu_api_error`；关闭对照中未收到事件上报。
- 500 → 200：实际请求两次并成功退出。默认事件中有 `tengu_api_retry`
  和 `tengu_api_success`；关闭对照中未收到事件上报，仍实际重试成功。
- 默认错误 / 重试事件包含 Linux、ARM64、Ubuntu、内核版本和
  `deployment_environment=unknown-linux`。还带有错误 / 栈的摘要及部分诊断字段。
  这些字段的存在不等同于平台将用户判定为异常。
- 400 事件中观察到 `extra_ca_certs=true`、`https_proxy=false`、
  `response_server=other`、`gzipSkipReason=custom_ca`。**额外 CA 和非官方
  响应服务器是本地 TLS 测试夹具有意产生的条件**，不能据此说日常越南
  线路也有相同字段，或官方已识别 / 处罚代理用户。本轮不将这些诊断值伪装掉。

400 / 500 场景没有读取 Apple 产品名，也未在接收请求正文中观察到该值。
所有 CLI 场景仍有内部启动探测。这轮未模拟真实进程崩溃，也未覆盖所有
失败和重试策略。策略 / 配置接收端响应简化，事件总量不解释为正常使用频率。

本轮看到的是事件遥测中的错误与重试数据，**不等同于完成第三方错误跟踪
服务的验收**。官方说明该独立错误报告通道涉及 Pro / Max 登录等条件；
本轮无真实订阅登录，不伪造这些条件。见
[官方数据与错误报告说明](https://code.claude.com/docs/en/data-usage)。

原件：`test-results/client-environment-audit/runtime-hooks-errors/`，包含
接收响应状态、hook 事件、strace、实际脚本与客户端输出。独立复核命令
`node scripts/audit-claude-hooks-errors.mjs`，结果为同审计目录下
`hooks-errors-report.json`。复核追踪的成功读取、对应进程、首次请求内容、
响应状态与输出，并解码事件元数据，分开核对合成条件。

17:50:07 再核对原 VM / 浏览器运行、网络防护与机器标识，结果正常，
审计客户端、追踪器及夹具进程均已退出。原件：
`hooks-errors-production-after.json`、`hooks-errors-guest-after.json`。
没有向生产 HOME 写入 hook / 设置，没有改系统证书或真实线路。

## 第五轮：远程控制标识与无账号功能门槛

运行完成于 **18:12:00（台北时间）**。新增 7 条记录，含 1 条校准和
6 条 CLI 场景；五轮合计 **53 条记录 / 9 条校准 / 44 条 CLI 场景**。
另做 8 处版本绑定的静态调用关系核对，不将静态摘录计作运行场景。

### 可读代码显示的另一份标识与注册内容

`getOrCreateRemoteControlMachineId` 是单独路径，读取 / 保存配置中的
`remoteControlMachineId`。有效已有 UUID 时复用；否则调用 crypto.randomUUID
并尝试保存；不能完成保存等情形可返回 null。它不同于 Messages 的 userID、
配置 machineID 和 Linux 系统机器标识。**本轮未因缺少订阅登录而走到
实际注册，不能把这段代码写成已经发送了该标识。**

桥接注册构造代码还显示：`machine_name` 取自 os.hostname；载荷可含
machine_id、工作目录、分支 / 仓库信息，以及可选的 host profile。
host profile 受配置 / 策略控制，构造代码包含平台、架构、发行版、
工具库存，以及可选 MCP 信息。该静态结构不是所有账户都会发送这些
字段的证明，更不是发送 Apple VM 名称或服务端已识别 VM 的证明。

这些字段关系进一步说明：重置浏览器资料与清理 CLI 各类配置是不同范围。
不得将所有 device / machine 标识都解释为 `/etc/machine-id`，也不能凭
其中一个已核对字段推定其他功能的标识都相同。

### 实际运行结果

| 场景 | 实际结果 | 已验证范围 |
| --- | --- | --- |
| auth status，无凭据 | loggedIn=false，authMethod=none，退出码 1 | 没有接收端请求，实际有 UUID 探测尝试 |
| auth status，仅合成 API key | loggedIn=true，authMethod=api_key，退出码 0 | 本地测试 key 已被配置，不代表官方验证 key；只收到两次设置 / 策略 GET |
| remote-control 默认 / 关闭非必要流量 / help | 三者均在订阅登录门槛退出，退出码 1 | 没有接收端请求，没有桥接注册，本轮也没有执行 UUID 探测 |
| 只读 doctor | 正常打印诊断，退出码 0 | 实际有 UUID 探测和设置 / 策略请求；没有模型请求或桥接注册 |

所有六个场景均未读取到 Apple 产品名称；只有校准读取到了该名称。
说明不同子命令的执行阶段和读取集合不同；Remote Control 门槛前没有
探测，不等于订阅登录后的整个远程控制流程都不读取或发送系统资料。

**auth status 的“已登录”不是账户有效 / 许可通过证明。** 本轮放入的
key 明确是合成字符串，实际官方服务器根本没有收到它。状态展示、
供应商接受凭据、目标功能资格须分别验证。

doctor 提示安装入口缺失、安装方式未设置、策略回答不能解析，以及
无法核验远程控制。这些来自本轮临时安装路径和简化 GET 响应：接收端
虽然返回 200，JSON 结构不是正常策略结构。不能据这份诊断认定用户真实
越南代理破坏响应，或将客户端提示中的“可能是代理”当成已查明原因。
没有执行 doctor 建议的安装、配置修改或其他修复。

[官方 Remote Control 条件](https://code.claude.com/docs/en/remote-control)
包含订阅登录和资格 / 策略检查；API key 不作为该功能的登录方式。
[官方命令说明](https://code.claude.com/docs/en/cli-reference)说明 auth status
与只读 doctor 的用途。真实登录后的路径继续保持未验证，不伪造 OAuth、
订阅或资格来取得“通过”结果。

原件：`test-results/client-environment-audit/runtime-features/` 与
`static/feature-paths.json`。独立复核：
`node scripts/audit-claude-features.mjs`；结果 `features-report.json`。
复核逐字匹配静态摘录与原执行文件位置，并核对追踪、退出、请求和配置。

18:15:44 核对原越南 VM / 浏览器仍运行、防护有效、系统机器标识摘要
不变，审计进程均已退出；原件 `features-production-after.json` 与
`features-guest-after.json`。当前日常用户目录仍未安装 Claude Code。

## 继续检查的范围

- 真实认证、订阅 / OAuth、服务端特性开关与策略响应：无账号测试不能替代。
- Remote Control 已核对门槛及静态结构；订阅登录后的注册、host profile 收集 / 发送仍未实测。
- 真实插件与其他 MCP、其他 hooks 事件 / 受管配置、更新、真实崩溃与订阅错误报告、其他工具路径和之后的版本。
- Messages 的 device_id 与配置 userID 关系已核对；其他功能中 machineID、
  系统机器标识及派生 / 散列字段如何读取和发送仍需分别检查。
- 继续核对敏感路径查询触发条件；工具规则的间接读取限制已实测，进程级文件访问限制仍需单独检查。
- 各版本分别审计；旧结果不自动继承到更新后的客户端。

本轮不修改产品遥测配置、不修改官方客户端、不隐藏硬件标记。
核心结论是：命令行存在直接查询及回传系统事实的通道，不能仅凭关闭遥测
承诺它与物理电脑无法区分。见 [统一待办](TODO.md)。

资料：[官方数据说明](https://code.claude.com/docs/en/data-usage)、
[官方环境变量说明](https://code.claude.com/docs/en/env-vars)。实际行为以本轮
版本绑定的追踪和接收端原件为准；不将资料描述扩展为服务方风控规则。
