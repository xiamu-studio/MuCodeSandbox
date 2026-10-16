# 正式 .deb 安装恢复演练

目标：更新已有 ZIP 演练以验证当前批准的 Google ARM64 稳定 .deb，保留安装事务各阶段实际中断、旧二进制 / AppArmor 策略 / recipe、合成浏览器资料、沙箱和网络边界检查。不修改生产 VM，不登录真实账号。

选择复用现有事务与隔离夹具，按批准 release 的 recipe / format 生成测试。另写一套安装器会绕过产品实际代码；在生产环境杀安装进程会无谓影响用户资料，均不采用。

步骤：

1. 使用当前正式 .deb 缓存并核对固定 SHA-256；新建独立 dataDir / Lima VM，4核、4GiB、10GiB，不实例化生产 Store。
2. 调用实际 ensureGuestBrowser 和 browserInstallTransactionScript，使用正式 recipe / archive.deb。
3. 在真实 .deb 解包入口注入失败，断言替换脚本确实被注入；旧程序、canary、安装记录保留。
4. 在 prepared / backed-up / switched / configured / committed 处暂停并杀掉本次安装进程；正常恢复后核对旧程序摘要、策略、记录与合成 Cookie / storage。
5. 修改临时 VM 的测试归档一字节，使用批准 recipe 证明实际校验拒绝；随后还原测试归档。不能改批准清单的校验值来冒充归档校验测试。
6. 保存限定报告和捕获材料，清理本脚本创建的临时 VM / fixture / dataDir。历史 ZIP 报告不更改；本次不冒充真实版本升级或正式 Electron 包验证。

这些均属已经授权的项目自测，不恢复物理休眠、真实切网、24小时、管理员认证或账号测试。
