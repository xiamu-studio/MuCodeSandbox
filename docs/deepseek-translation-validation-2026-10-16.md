# DeepSeek 中英互译（0.4.50 已安装）

2026-10-16，台北时间。**0.4.50 / 2b0833ccfe2b607f 已安装并恢复原环境**。用户确认保存草稿后，正常停止环境、退出0.4.49，严格检查并替换应用；旧包保留在 `/Users/staff/Applications/.MuCodeSandbox-before-0.4.50.app`。代理没有收取真实Key，也没有执行付费API调用。

## 行为

- 现有中文输入浮窗改为DeepSeek Flash双向翻译：含汉字自动译英文，纯英文自动译简体中文；中英混合可手选方向。结果可编辑，核对后显式复制或粘贴，终端不自动执行。
- 固定官方 `https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`（官方当前Flash名称，旧 `deepseek-v4-flash` 兼容名已转到新版）。非思考、无工具、非流式、单次请求。提示词只要求翻译，不回答原文问题或执行原文指令；真实翻译质量仍需用户使用验证。
- 最多2000字输入、4096生成token、16000字结果；完整结果才交付。连接6秒、HTTP30秒、客体进程36秒封顶。区分401、402、429、TLS、超时和截断；失败保留原文，不重试、不切换Google、不使用Mac直连。
- 所有入口共用同一浮窗：浏览器、Linux桌面、Claude Code终端、Shell。初始浮窗仍保持380px内/260px高的既有边界，设置默认折叠。

## Key和资料边界

- 在本机小窗展开翻译设置，密码框填Key，点击保存；保存后输入框清空，状态API只返回是否配置及模型，不回显Key，不自动测试。
- 使用现有AES-256-GCM加密，独立0600应用文件 `~/.mucodesandbox/translation-provider.json`；不写SQLite环境配置、不进入VM快照/备份、不进项目或GitHub，不改变现有Store实现。
- Key属于本机应用翻译设置，各入口共用；环境重建不等于清除此应用级Key，可在设置中明确移除。
- 请求时Key与原文通过stdin传入受保护客体进程内存，不写客体磁盘、argv或日志；实际HTTPS需要Key出现在客体请求进程内存中，并发送给官方DeepSeek端点。其他同权限客体进程/已失陷系统不在额外硬件隔离承诺内。
- 固定端点、禁止重定向与证书绕过；拒绝不安全符号链接/硬链接/权限和损坏密文。设置变化时不交付旧请求结果。

## 验证

- 41项后台测试通过：中英方向、请求构造、纯翻译提示词、无思考/工具、Key不进argv、失败脱敏与无重试、撤销授权拒绝/结果拒绝、Key加密与权限、API鉴权及拒绝注入端点。
- 独立本地UI通过：密钥框遮蔽、保存后清空、不读回原Key、配置不发送翻译、双向与手选、原文保留、不自动粘贴/重试、390px边界。
- 四入口快捷工具回归、原有中文/文件便利性UI通过；没有主动访问AI客户端、真实AI网站或线上翻译。
- 当前真实VM的受监督dev任务执行完全相同的Python程序，但curl被本地假函数替换；没有使用真实Key、外部请求或产生文件。防护active/verified、许可有效；前后当次启动防护摘要一致。
- TypeScript、构建、包严格ad-hoc签名和篡改拒绝检查通过。14个已安装模块逐字节未变：network-guard、guest-lease、transparent-network、egress、runtime、manager、terminal、host-network、guest-display、guest-display-runtime、guest-browser-runtime、guest-desktop、store、backups。

证据：test-results/deepseek-translation/ 下 ui.json、guest-local.json、tests.log、candidate.json、package.log、all-tools.log、convenience.log。

官方来源：[首次调用](https://api-docs.deepseek.com/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[非思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 安装后核对

- 原环境和浏览器恢复运行，只打开已配置的本地首页；未打开真实AI网页或桌面客户端。
- 本机窗口显示v0.4.50 / 2b0833cc，DeepSeek设置可展开，安全文本框与保存/移除按钮完整可见；Key入口已打开交给用户。打开设置只读取配置状态，不发付费请求。
- 原浏览器根目录和Default目录inode一致；6核6GiB30GiB、时区语言、严格透明代理、批准出口和3200×2000/2×保留。
- api.ipify.org与icanhazip.com两个实际HTTPS检测均为166.88.36.199；防护active / verified、许可有效，当前启动摘要与批准记录一致。
- 14个核心编译模块安装后仍与候选/旧版一致。证据：install.json、restart.json、installed-verification.json、key-entry-ready.png（均在test-results/deepseek-translation/）。
- 真实Key由用户本机输入，首次线上翻译由用户自己点击；线上质量和账户可用性没有被本地模拟验证替代。
