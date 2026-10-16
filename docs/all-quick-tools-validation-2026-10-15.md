# 所有工作入口的快捷工具（0.4.49 已安装）

2026-10-15：**0.4.49 / f75cfe47b11be16a 已安装并恢复原环境**。用户保存草稿后更新；四入口共用文件与中文/翻译工具，终端粘贴不自动执行。原浏览器资料目录、6核6GiB与防护保留，两处实际出口检测均为166.88.36.199、防护核验通过。防护与IP记录的提示已简化，原始证据不改写。[交付记录](all-quick-tools-validation-2026-10-15.md)

## 行为

- 浏览器、桌面显示、Shell、Claude Code 终端共用 `GuestQuickTools`，都提供文件与粘贴、中文输入和显式翻译。桌面显示原有入口保留，未额外叠放一套工具条。
- GUI 沿用客体剪贴板 / Ctrl+V。CLI 使用当前已连接的 xterm / WebSocket；文字和译文粘贴到当前光标，不自动按回车。
- CLI 的“取回终端选中文字”只读取当前 xterm 明确选择的文本，不取 X11 剪贴板，也不后台读取 Mac 剪贴板。
- 文件仍用原有受保护的上传 / 列表 / 下载 API。可直接把带引号的 Linux 文件路径粘贴到当前终端。捕获文件拖入事件，避免 xterm 同时把宿主路径或拖入附带文本粘贴进去。
- 多行 / Tab 仅在终端已启用 bracketed paste 时允许；否则拒绝且保留原文。拒绝 ESC、控制字符等可跳出粘贴边界的内容。长 Unicode 分块不切断代理对。明确点击“回车”仍是用户主动操作。
- 工具跟随当前连接、环境与入口。隐藏 / 断线不能发送；重连保留当前入口草稿；切换新环境为空白。没有引入跨重启持久草稿或自动同步。
- 浮窗跟随工具条实际高度，窄屏折行后不压住按钮；不占大块正文空间。
- 上轮翻译错误分类一起包含于候选，仍只用户点击时请求 Google；没有额外线上翻译测试，没有宣称最初失败已定位。

## 验证

- `scripts/verify-all-quick-tools.ts`：生产组件、本地模拟 RFB / WebSocket / API，四个入口均能使用工具；CLI 中文 / 译文无额外回车、多行安全边界、引号文件路径、直接文本传输、文件拖入不触发终端输入、实际 xterm 选择后取回、重连草稿、环境切换与断连禁用、390px 按钮与浮窗边界通过。未打开真实 AI 客户端、网站或外部翻译服务。
- `scripts/verify-guest-convenience-ui.ts`：既有中文选词、复制粘贴、文件传输、列表与窄窗口流程通过。
- `scripts/verify-fixed-display-ui.ts`：上轮的小窗口边界、固定分辨率、坐标、全屏 / 重连和隐藏页检查通过，工具共用未改变查看器分辨率策略。
- 29 项相关单元 / 运行时检查通过；TypeScript、构建、安装包严格 ad-hoc 签名、依赖与篡改拒绝检查通过。
- 真实当前 VM：两个独立临时 Bash PTY 使用无配置文件的合成 printf 对照。安全粘贴不执行内容，普通换行负对照确实执行合成标记。临时进程已终止并回收，没有文件或外部请求，防护摘要未变。此项不冒充真实 Claude Code 任务或所有 TUI 的全面兼容性验收。
- 候选编译资源逐一匹配；九个安全与终端核心服务模块和当前安装版相同：terminal、runtime、network-guard、guest-lease、transparent-network、egress、manager、service、host-network。当前环境仍为运行、防护 verified、许可有效。

夹具曾因并行 Vite 实例共用依赖缓存出现 Outdated Optimize Dep，已给新夹具独立临时缓存并在结束清理；最终复测通过，不把夹具缓存故障当作产品连接失败。

证据：`test-results/all-quick-tools/ui.json`、四入口截图与 `narrow-terminal.png`、`guest-paste.json`、`candidate.json`、`build.log`、`runtime-tests.log`、`package.log`。

安装包：`release/all-tools-0449/mac-arm64/MuCodeSandbox.app`。更新前必须先保存小窗未发送草稿；它们仅在当前窗口内存，正常重启会清空。浏览器资料和 VM 文件沿用正常维护流程保留。


## 安装后核对

- 本机窗口显示0.4.49 / f75cfe47b11be16a；实际终端已连接，文件与粘贴、中文输入及浮窗可见。没有提交文字、读取剪贴板或主动调用线上翻译。
- api.ipify.org与icanhazip.com两处实际HTTPS检测均返回166.88.36.199。防护active / verified、许可有效，当前启动摘要与批准记录一致。两份独立回执规则保留。
- 浏览器资料根目录和Default目录inode未变，6核6GiB30GiB、时区语言、严格透明代理和3200×2000/2×保留。
- 停止时改为“沙箱已停止，暂停检测”；恢复记录显示“重新检查通过”，复杂说明默认折叠。原始事件与导出不改写；九个安全核心模块与0.4.48相同。新构建的防护/网络UI、包严格签名与篡改拒绝检查通过。
- 安装备份：/Users/staff/Applications/.MuCodeSandbox-before-0.4.49.app。证据位于test-results/all-quick-tools/：install.json、restart.json、installed-verification.json、protection-copy.log、network-copy.log。
- 虚拟机身份未改。Lima VZ / Ubuntu ARM64不能保证对原生客户端隐藏虚拟化；资源优化不代表实体硬件等价。
