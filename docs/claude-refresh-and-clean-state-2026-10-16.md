# 当前沙箱 Claude 更新与首次使用状态

2026-10-16，台北时间。用户授权更新 Claude Desktop 与 Claude Code CLI，并清空应用数据，在自行登录前回到首次使用状态。本次仅维护当前 Linux VM：`mu-76c193f709a24544`；MuCodeSandbox 应用保持 **0.4.51 / 004b50d99b77e22f**，没有改动其源代码或网络规则。

## 已完成

| 软件 | 原版本 | 当前版本 | 核对 |
| --- | --- | --- | --- |
| Claude Desktop | 2.31226.1 | 2.42304.0 | 官方签名 apt 索引，arm64、176002208 字节、SHA256一致；dpkg安装文件校验通过；没有启动客户端 |
| Claude Code CLI | 2.1.296 | 2.1.301 | 官方npm包；安装后的原生执行文件与签名manifest的linux-arm64 SHA256一致；断网临时环境中读取版本号通过 |

- Desktop 包 SHA256：`8fb3c4203e53882f037acc822f350c7d3da66cd691e39b98aeed4d66d7328648`。
- CLI 原生文件 SHA256：`1e119036a802d359ba5f9886428e031586e8796f7a858d5a8ee179ac7b8604f0`。
- 官方签名密钥主指纹：`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`。核对指纹后验证发布清单签名，不仅依赖下载URL。
- apt模拟与实际升级范围仅Claude Desktop：1升级、0新增、0移除；没有安装推荐的QEMU/Cowork组件，没有升级Node、npm或其他系统包。使用现有受保护客体网络下载，未使用Mac直连回退。
- CLI版本探针使用独立PrivateNetwork命名空间、空临时HOME/配置目录、只读系统和关闭自动更新/非必要流量；退出后临时目录/单元清理。没有登录、模型请求或真实账号检查。

## 已清理的实际资料

- `/home/dev/.local/share/mucodesandbox/desktop-clients/claude-desktop`：受管Desktop的profile/config/cache/data等全部内容清除；重新建立为空的dev所有0700根目录。
- `/home/dev/.claude`：CLI全局配置、会话、缓存、凭据等全部内容清除；重新建立为空的dev所有0700目录。
- `/home/dev/.claude.json`：清除。已核对没有残留的已知配置备份。
- 17个其他已知Claude专用旧路径原本不存在，包括旧版XDG配置/缓存/数据、CLI状态缓存与旧下载包路径。工作目录和HOME下未发现项目级`.claude`或`.mcp.json`配置；未发现通用钥匙环目录或shell中的Claude认证环境变量。
- 没有复制或备份旧账号资料，没有读取聊天内容或密钥。更新下载的临时缓存、签名核验目录和Desktop下载包已移除。
- 清理程序使用固定目录清单与锚定目录描述符，不跟随父路径/叶子符号链接，目录递归使用抗符号链接攻击的实现；在自建临时目录测试了外部链接目标、其他应用和未知文件不受影响。没有在真实项目上做破坏性测试。

## 结束时核验

- Desktop专用资料目录和CLI用户资料目录均0文件，权限0700；`.claude.json`不存在。
- 没有运行中的Claude客户端进程或其子进程。两个客户端保持关闭，首次登录由用户自行操作；没有打开Claude登录页或其他真实AI网页。
- 项目根目录、浏览器资料根目录/Default和Grok资料目录inode保持；原DeepSeek Key文件inode、大小、权限及配置状态保持。
- 6核6GiB30GiB、语言/时区和严格透明代理保持。防火墙、开机规则、代理配置、许可规则/启动摘要前后一致；防护active / verified、许可有效。
- 结束时实际HTTPS检测ipify与icanhazip均为`166.88.36.199`。没有将两个目标的结果扩称为每个网站逐连接证明，也没有宣称新客户端真实账号/高级功能已验收。

本轮开始前，06:47:38 UTC的出口检测超时已经触发保护并确认停止。之后通过应用正常启动重新核验恢复，保留原事件；没有改变两份独立有效一致检测结果的要求。

## 证据与范围

证据在 `test-results/claude-refresh-2026-10-16/`：before.json、cli-release.json、cli-verification-metadata.json、cli-install.log、cli-offline-version.json、desktop-release.json、desktop-plan.log、apt-index.log、desktop-install.log、cleanup-fixture.json、reset-result.json、after-inventory.json、final.json。

这次更新的是当前沙箱里的软件与本地客户端数据；没有清空浏览器资料、项目文件、Grok、Mac上的Claude、虚拟机快照或其他应用。新建环境的初始固定安装清单和整套应用的自动更新机制不属于本次维护。

官方依据：[Linux桌面安装与更新](https://code.claude.com/docs/en/desktop-linux)、[CLI npm更新/签名校验/配置清理](https://code.claude.com/docs/en/setup)。
