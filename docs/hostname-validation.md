# 普通、稳定的客体主机名验证

2026-10-11 实现范围：只设置 Linux 客体的普通设备名称，不修改 Mac 主机名、
机器标识、DMI、CPU、驱动或虚拟硬件。默认名称形如 `desktop-83ab91cd`，首次保存
后在同一环境的重复初始化和重启中复用。不同克隆环境以系统实际的 `machine-id`
识别；检测到真实机器标识变化时生成该环境自己的名称。cloud-init `instance-id`
只保存其摘要作为当前启动身份的审计记录，不作为名称必须更新的条件。

## 持久化与迁移

- `/etc/mucodesandbox/guest-hostname.json`：root 所有、0600，记录版本、名称、
  选择来源以及 `instance-id` / `machine-id` 的 SHA-256。不会每次开机重新随机名称。状态损坏时
  拒绝覆盖；缺少或使用不区分环境的通用 cloud-init 身份或尚未初始化的 machine-id 时也拒绝继续。
  助手仅读取系统实际 machine-id，不改写它；基础镜像原有的 cloud-init clean
  --machine-id 负责克隆时正常生成独立机器标识，避免秒级 instance-id 重复的问题。
- `/usr/local/libexec/mu-guest-hostname`：root 所有、0755，仅接受 root 执行的
  `apply` 命令，无 CLI 替代根目录或放宽所有权选项。
- `/etc/cloud/cloud.cfg.d/99-mucodesandbox-hosts.cfg`：root 所有、0644，使用
  `preserve_hostname: true`、`manage_etc_hosts: false`，由受控助手统一维护名称。
- `/etc/systemd/system/mucodesandbox-hostname.service`：root 所有、0644，启用后
  在 `cloud-init.service` 之后、`cloud-config.service` / `cloud-final.service`
  之前恢复名称。因此 datasource 的初始化先完成，助手再核对已保存的名称。

首次迁移会把旧 `lima-mu-*` 内部名称替换为普通名称；已有普通手工名称可以保留。
助手同步内核主机名、`/etc/hostname` 和 `127.0.1.1` 映射，只移除相关旧名称的
回环别名，保留其他别名、注释、`host.lima.internal` 网关和非回环地址记录。
所选名称已有非回环映射时拒绝修改，避免同名解析到外部地址。它不修改 DNS
解析器或全局网络配置。先保存名称状态再应用，内核设置失败后的重试继续使用
同一个名称。

所有受控输入、输出文件及祖先目录检查所有者、组、写权限、文件类型、符号链接、
硬链接和大小。普通开发用户不会获得新的 sudo 权限。基础镜像配方包含助手内容，
内容变化后旧缓存不作为新配方使用；基础镜像中的名称不会作为所有克隆共用名称。
运行中的旧环境不会因此自动重启；在其下一次完整启动或准备防护时安装设置。

隔离实测发现，本项目 Lima 2.2 在重新 start / restart 时会生成新的 instance-id，
真实 machine-id 保持不变。原先同时要求两个摘要不变的判定会错误地重新随机名称；
现已改为 machine-id 相同即保留名称和选择来源，只更新 instance-id 审计摘要。
助手仍不改写任何真实标识。此修正后的真实重启结果以新运行回执为准。

源码提供 `configureGuestHostnameScript(name?)` 和 `validateGuestHostname`。
可选名称限制为 1–63 字符的小写 DNS 单标签，首字符为字母，末尾不能为连字符，
拒绝 `localhost` 等保留名称。当前批次提供自动名称和受控脚本接口，没有新增
界面字段。

## 已完成的临时文件验证

在项目目录执行：

```sh
node --test tests/guest-hostname.test.ts
```

2026-10-11：17 项通过。测试在自己的临时目录执行同一 Python 助手，替换内核
设置调用，覆盖首次迁移、已有普通名称、显式选择、重复初始化、模拟重启、克隆
身份变化、cloud-init 覆盖修复、中断后重试、损坏状态、缺失 / 通用身份、符号
链接 / 硬链接、Lima 更换 instance-id 但真实 machine-id 不变、同秒 cloud-init
身份与独立 machine-id、不安全所有权与权限、非回环同名冲突。测试没有写 Mac 系统文件，
没有启动真实虚拟机，不能据此宣称完成了 Linux 开机验收。

## 隔离虚拟机运行验收

以下脚本需要独立安排运行；本次实现没有直接运行它：

```sh
node scripts/verify-hostname-security.ts
```

脚本在自己的 `.mu-hostname-verification-*` 临时数据目录创建基础镜像和
4 核 / 4 GiB 严格模式测试克隆，不接入 Claude 账号，不调用付费模型。它可能
需要现有 Ubuntu、Lima 或防护组件缓存；运行前核对缓存和资源条件，避免把下载
动作当作名称单元测试。

验收核对真实内核名、hostname 文件、保存状态、回环解析、开机单元启用 / 重启
后活动状态，并对照基础镜像初始化输出和克隆的身份摘要 / 名称，证明没有复用
基础镜像身份。随后重启、模拟旧 Lima 名称 / 缺少状态、走已有初始化路径并再次
重启。保留原先的代理可用、直连阻断、dev 不可任意提权、网关 / DNS 不变和首开
抓包检查。

新回执写入 `test-results/hostname-persistence.json`，抓包写入
`test-results/hostname-persistence-first-boot.pcap`。旧的
`hostname-security.json` / `hostname-first-boot.pcap` 是此前“修复 Lima 名称
解析”的限定历史证据，不证明普通名称已部署。脚本默认清理自己创建的虚拟机；
失败时 `MU_KEEP_FAILED_HOSTNAME=1` 会停止虚拟机后保留临时目录。

本批次真实 Linux 首开、重启、克隆身份和真实 `getent` / sudo 行为，须以新运行
回执为准。现有越南虚拟机与已安装应用不作为故障注入对象。
