# Code Sandbox 新版与本项目的差异

2026-10-12，台北时间。证据包括用户提供的beta.16更新界面、实时官网、公开发布清单、CloakBrowser官方说明和本机旧包的只读签名检查。没有运行或更新对方应用，没有读取账号，没有下载约301 MB的新DMG。

## 版本边界

用户截图：0.5.4-beta.12 → 0.5.4-beta.16，发布时间2026-10-12 19:06，内容说明改用CloakBrowser免费内核、按出口匹配语言时区、清缓存生成新指纹且默认保留登录 / 收藏 / 密码，可额外选择清站点资料，升级保留原资料与恢复副本，Chrome扩展连接仍待排查。

实时[下载页](https://code-sandbox.cc/download/)仍显示beta.15，公开[发布清单](https://cdn.s3.loki.zaneliu.me/code-sandbox/releases/0.5.4-beta.15/manifest.json)也是beta.15。清单是Ed25519封装格式；本次只读取，没有独立验证其签名。不能把官网静态页当成beta.16完整实现证明。

本机 `/Applications/Code Sandbox.app` 的CFBundleShortVersionString为0.5.4，签名adhoc、无TeamIdentifier。此前反编译的是旧包；不因此断定作者没有开发者账号，也不将旧包签名推给新包。

## 主要差异

| 项目 | 对方证据 | 我们的当前情况 | 意义 |
| --- | --- | --- | --- |
| 浏览器信息 | beta.16截图改用CloakBrowser；官方引擎说明改写Canvas、WebGL、字体、GPU、屏幕等 | VM中官方稳定Chrome，保留真实Linux / ARM / 软件图形 | 浏览器路线实质不同，不能用删除一种字体称为相同 |
| 浏览器位置 | 旧包有darwin浏览器模块和Mac Chromium镜像，新版位置未动态重验 | 已证实在Ubuntu ARM64 VM，Mac接收画面 | 包含Mac组件不等于所有桌面客户端都在Mac，也不能证明防漏效果 |
| 资料重置 | 截图默认保留登录、收藏、密码而重生成指纹 | 关闭保留、Chrome重置清资料、VM完整重建清整个旧盘与本应用恢复副本 | 浏览器新标识和全新VM是不同操作，不清掉网站后台记录 |
| Desktop与宿主 | [官网](https://code-sandbox.cc/)说明Code Local / Cowork可访问本机，CLI无感模式另管；旧包有Mac原生适配 | 原厂Linux Claude / Grok、受控文件 / 手动文本传输、有限宿主目录与Git能力 | 对方本机集成更广，我们的宿主权限范围更小；不能据此单方面判定谁更安全 |
| 线路 | 官网宣称美国自有公寓住宅出口；未独立核验 | 已核验166.88.36.199，美国VPS机房 | 来源质量区别不由沙箱或浏览器引擎自动改变 |
| 网络防护 | 旧包Mac sing-box、管理员辅助组件、Linux nft；完整动态故障行为未验 | 客体TUN / DNS / nft、短期许可、两个独立一致回执；失败真的停机 | 我们有受控证据，但存在偶发核验超时；对方无法由截图确认全部防护有效 |
| 产品交付 | 官方Mac / Windows下载，更新频道、授权和支持流程，截图有签名清单和恢复副本 | Mac本机测试包，手动发布，故障记录与恢复正在补齐 | 确有产品化缺口；不用大规模浏览器源码编译也能完善 |

## 关于 CloakBrowser

[官方仓库](https://github.com/CloakHQ/CloakBrowser/blob/main/README.md)描述它是修改Chromium源码后提供的二进制，也提供Mac / Linux / Windows支持、稳定seed和代理地区匹配。接入预编译包不需要我们自己编译几十GB源码，但要验证来源、签名、版本、资料兼容、授权和稳定的身份。底层设备 / VM并不会因此变成物理机，网页层改写不代表CLI系统检测已隐藏。

当前CloakBrowser官方新版本介绍需要GitHub取得免费key或使用付费key；用户截图说Code Sandbox无需额外key。对方可能采用不同免费版本 / 集成流程，未取得beta.16实际引擎前不能确认。引擎作者的检测站点宣传也不是平台账号安全保证。

## 对方风险说明与我们的处理

[使用须知](https://code-sandbox.cc/guide/precautions/)明确80%是其交付建议，不是Claude官方风控阈值。[下载页](https://code-sandbox.cc/download/)也不承诺不封号。平台已有记录不能靠本地重置删除。其“不让AI改交付配置”是对其产品客户的建议，不能覆盖用户已经授权我们开发自己的项目。

我们继续先完成故障证据、手动恢复与当前真实浏览器路线，不根据这些截图擅自替换引擎、改操作系统指纹或扩大Mac宿主权限。

[旧包证据](competitor-desktop-review-2026-10-12.md)、[本项目0.4.17限定验证](guest-workspace-handoff-validation-2026-10-12.md)。
