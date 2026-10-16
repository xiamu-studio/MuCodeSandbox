# MuCodeSandbox 源码与文档文件清单

生成时间：2026-10-12T22:19:57+08:00（台北时间）。
项目根目录：`/Users/staff/Documents/AIbox/AI/AIbeng/MuCodeSandbox`。
本次共 **486 个文件**，包含工作区中尚未提交的实际文件。

该清单覆盖源码、配置、文档、测试、脚本和资源；遵循项目忽略规则，
依赖、编译产物、测试原件、Git 内部文件、原生二进制和真实 VM 数据不逐文件展开。
这些目录的位置和用途在文末单独列出。文件存在不代表功能或测试已通过。

[项目总览](../PROJECT_OVERVIEW.md) · [待办](TODO.md) · [文档导航](README.md)

## 目录统计

| 目录 | 文件数 |
| --- | --- |
| (root) | 12 |
| assets | 1 |
| desktop | 5 |
| docs | 124 |
| examples | 1 |
| native | 7 |
| scripts | 183 |
| server | 61 |
| shared | 13 |
| src | 26 |
| tests | 53 |

## (root)

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [.gitignore](../.gitignore) | 项目入口、依赖、构建配置或说明 |
| [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md) | 项目入口、依赖、构建配置或说明 |
| [PROJECT_REVIEW_2026-10-11.md](../PROJECT_REVIEW_2026-10-11.md) | 项目入口、依赖、构建配置或说明 |
| [README.history-2026-10-11.md](../README.history-2026-10-11.md) | 历史记录；不作为当前配置或执行指令 |
| [README.md](../README.md) | 项目入口、依赖、构建配置或说明 |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | 项目入口、依赖、构建配置或说明 |
| [index.html](../index.html) | 项目入口、依赖、构建配置或说明 |
| [package-lock.json](../package-lock.json) | 项目入口、依赖、构建配置或说明 |
| [package.json](../package.json) | 项目入口、依赖、构建配置或说明 |
| [tsconfig.json](../tsconfig.json) | 项目入口、依赖、构建配置或说明 |
| [tsconfig.server.json](../tsconfig.server.json) | 项目入口、依赖、构建配置或说明 |
| [vite.config.ts](../vite.config.ts) | 项目入口、依赖、构建配置或说明 |

## assets

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [assets/icon.png](../assets/icon.png) | 界面 / 应用资源 |

## desktop

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [desktop/browser-home.html](../desktop/browser-home.html) | 桌面启动、窗口或本地页面资源 |
| [desktop/identity.cjs](../desktop/identity.cjs) | 桌面启动、窗口或本地页面资源 |
| [desktop/identity.html](../desktop/identity.html) | 桌面启动、窗口或本地页面资源 |
| [desktop/main.cjs](../desktop/main.cjs) | 桌面启动、窗口或本地页面资源 |
| [desktop/preload.cjs](../desktop/preload.cjs) | 桌面启动、窗口或本地页面资源 |

## docs

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [docs/README.md](../docs/README.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/TODO.md](../docs/TODO.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/account-environment-review-2026-10-11.md](../docs/account-environment-review-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/actual-sleep-validation.md](../docs/actual-sleep-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/architecture.md](../docs/architecture.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/archive/browser-native-patch-validation.md](../docs/archive/browser-native-patch-validation.md) | 历史记录；不作为当前配置或执行指令 |
| [docs/archive/current-state-0.4.6.json](../docs/archive/current-state-0.4.6.json) | 历史记录；不作为当前配置或执行指令 |
| [docs/browser-context-validation.md](../docs/browser-context-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-gpu-validation.md](../docs/browser-gpu-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-home-validation.md](../docs/browser-home-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-install-recovery-validation.md](../docs/browser-install-recovery-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-media-validation.md](../docs/browser-media-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-monitor-validation.md](../docs/browser-monitor-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-native-patch-validation.md](../docs/browser-native-patch-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-observable-audit-2026-10-11.md](../docs/browser-observable-audit-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-profile-validation.md](../docs/browser-profile-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-upgrade-validation.md](../docs/browser-upgrade-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-webgpu-device-loss-validation.md](../docs/browser-webgpu-device-loss-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-webgpu-validation.md](../docs/browser-webgpu-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-webgpu-worker-canvas-validation.md](../docs/browser-webgpu-worker-canvas-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/browser-webgpu-worker-validation.md](../docs/browser-webgpu-worker-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/cdp-lifecycle-review-2026-10-11.md](../docs/cdp-lifecycle-review-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/claude-client-validation.md](../docs/claude-client-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/cli-environment-audit-2026-10-11.md](../docs/cli-environment-audit-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/competitor-beta16-delta-2026-10-12.md](../docs/competitor-beta16-delta-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/competitor-comparison.md](../docs/competitor-comparison.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/competitor-desktop-review-2026-10-12.md](../docs/competitor-desktop-review-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/current-state-snapshot.json](../docs/current-state-snapshot.json) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/day-workflow-validation.md](../docs/day-workflow-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/deferred-validation.md](../docs/deferred-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/desktop-crash-validation.md](../docs/desktop-crash-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/desktop-display-separation-validation-2026-10-12.md](../docs/desktop-display-separation-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/desktop-installation-state-validation-2026-10-12.md](../docs/desktop-installation-state-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/desktop-launch-check.md](../docs/desktop-launch-check.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/desktop-layout-validation-2026-10-12.md](../docs/desktop-layout-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/device-signal-review-and-plan-2026-10-11.md](../docs/device-signal-review-and-plan-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/disk-recovery-interruption-validation.md](../docs/disk-recovery-interruption-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/domain-network-validation.md](../docs/domain-network-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/egress-probe-validation.md](../docs/egress-probe-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/egress-validation.md](../docs/egress-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/encrypted-upstream-validation.md](../docs/encrypted-upstream-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/fixed-display-validation.md](../docs/fixed-display-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/gaps-and-validation.md](../docs/gaps-and-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/gpu-route-review-2026-10-12.md](../docs/gpu-route-review-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/guest-audio-validation.md](../docs/guest-audio-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/guest-lease-validation.md](../docs/guest-lease-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/guest-workspace-handoff-validation-2026-10-12.md](../docs/guest-workspace-handoff-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/headline-latency-validation-2026-10-12.md](../docs/headline-latency-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/host-command-validation.md](../docs/host-command-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/host-network-validation.md](../docs/host-network-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/host-power-validation.md](../docs/host-power-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/hostname-validation.md](../docs/hostname-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/layout-validation.md](../docs/layout-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/linux-personal-computer-equivalence.md](../docs/linux-personal-computer-equivalence.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/local-test-delivery.md](../docs/local-test-delivery.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/mac-browser-enforcement-validation.md](../docs/mac-browser-enforcement-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/managed-desktop-design-2026-10-12.md](../docs/managed-desktop-design-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/managed-desktop-validation-2026-10-12.md](../docs/managed-desktop-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/network-destinations-validation-2026-10-12.md](../docs/network-destinations-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/network-observations-validation.md](../docs/network-observations-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/network-posts-comparison.md](../docs/network-posts-comparison.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/network-vps-static-residential-plan.md](../docs/network-vps-static-residential-plan.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/normal-linux-validation-2026-10-11.md](../docs/normal-linux-validation-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/packaged-browser-validation.md](../docs/packaged-browser-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/packaged-workflow-validation.md](../docs/packaged-workflow-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/plans/2026-10-09-completion-plan.md](../docs/plans/2026-10-09-completion-plan.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-09-network-and-identity-design.md](../docs/plans/2026-10-09-network-and-identity-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-09-transparent-network-design.md](../docs/plans/2026-10-09-transparent-network-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-browser-contexts-design.md](../docs/plans/2026-10-10-browser-contexts-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-browser-upgrade-design.md](../docs/plans/2026-10-10-browser-upgrade-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-claude-client-design.md](../docs/plans/2026-10-10-claude-client-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-claude-tui-design.md](../docs/plans/2026-10-10-claude-tui-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-delivery-controls-design.md](../docs/plans/2026-10-10-delivery-controls-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-egress-design.md](../docs/plans/2026-10-10-egress-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-guest-lease-design.md](../docs/plans/2026-10-10-guest-lease-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-host-command-design.md](../docs/plans/2026-10-10-host-command-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-portable-backup-design.md](../docs/plans/2026-10-10-portable-backup-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-snapshot-recovery-design.md](../docs/plans/2026-10-10-snapshot-recovery-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-10-wireguard-design.md](../docs/plans/2026-10-10-wireguard-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-browser-home-design.md](../docs/plans/2026-10-11-browser-home-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-cli-environment-audit.md](../docs/plans/2026-10-11-cli-environment-audit.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-disk-recovery.md](../docs/plans/2026-10-11-disk-recovery.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-history-button-design.md](../docs/plans/2026-10-11-history-button-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-host-network-design.md](../docs/plans/2026-10-11-host-network-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-host-power-design.md](../docs/plans/2026-10-11-host-power-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-layout-fix-design.md](../docs/plans/2026-10-11-layout-fix-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-navigation-priority-design.md](../docs/plans/2026-10-11-navigation-priority-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-network-logs-design.md](../docs/plans/2026-10-11-network-logs-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-normal-linux-implementation.md](../docs/plans/2026-10-11-normal-linux-implementation.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-retina-display-design.md](../docs/plans/2026-10-11-retina-display-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-11-usability-glass-design.md](../docs/plans/2026-10-11-usability-glass-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-access-latency-design.md](../docs/plans/2026-10-12-access-latency-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-desktop-display-separation.md](../docs/plans/2026-10-12-desktop-display-separation.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-desktop-installation-state-design.md](../docs/plans/2026-10-12-desktop-installation-state-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-desktop-layout-design.md](../docs/plans/2026-10-12-desktop-layout-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-egress-quorum-design.md](../docs/plans/2026-10-12-egress-quorum-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-guest-workspace-handoff.md](../docs/plans/2026-10-12-guest-workspace-handoff.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-headline-latency-design.md](../docs/plans/2026-10-12-headline-latency-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-managed-desktop.md](../docs/plans/2026-10-12-managed-desktop.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-network-destinations-design.md](../docs/plans/2026-10-12-network-destinations-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-protection-events-recovery.md](../docs/plans/2026-10-12-protection-events-recovery.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/plans/2026-10-12-unified-line-delay-design.md](../docs/plans/2026-10-12-unified-line-delay-design.md) | 设计 / 实施方案；不是验证通过证明 |
| [docs/port-forward-validation.md](../docs/port-forward-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/portable-backup-validation.md](../docs/portable-backup-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/project-file-stats.json](../docs/project-file-stats.json) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/project-files.md](../docs/project-files.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/project-status-history-2026-10-11.md](../docs/project-status-history-2026-10-11.md) | 历史记录；不作为当前配置或执行指令 |
| [docs/project-status.md](../docs/project-status.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/protection-events-validation-2026-10-12.md](../docs/protection-events-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/proxy-transport-validation.md](../docs/proxy-transport-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/retina-display-validation.md](../docs/retina-display-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/shared-mount-validation.md](../docs/shared-mount-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/snapshot-recovery-validation.md](../docs/snapshot-recovery-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/socks-upstream-validation.md](../docs/socks-upstream-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/storage-capacity-validation.md](../docs/storage-capacity-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/sustained-network-validation.md](../docs/sustained-network-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/technical-overview.md](../docs/technical-overview.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/unified-line-delay-validation-2026-10-12.md](../docs/unified-line-delay-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/usability-validation.md](../docs/usability-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/user-guide.md](../docs/user-guide.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/verification.md](../docs/verification.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/vps-dedione-setup-2026-10-11.md](../docs/vps-dedione-setup-2026-10-11.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/vps-relay-diagnostics-2026-10-13.md](../docs/vps-relay-diagnostics-2026-10-13.md) | 当前中继时间日志、实际出口故障、只读采集与恢复步骤 |
| [docs/vps-goal-validation-2026-10-12.md](../docs/vps-goal-validation-2026-10-12.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |
| [docs/wireguard-validation.md](../docs/wireguard-validation.md) | 说明 / 状态 / 待办 / 验证；具体版本见文件内容 |

## examples

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [examples/workspace/hello.js](../examples/workspace/hello.js) | 示例项目文件 |

## native

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [native/BridgeHelper.swift](../native/BridgeHelper.swift) | Mac 原生助手、沙箱配置或边界探针 |
| [native/NetworkMonitor.swift](../native/NetworkMonitor.swift) | Mac 原生助手、沙箱配置或边界探针 |
| [native/NetworkSnapshot.swift](../native/NetworkSnapshot.swift) | Mac 原生助手、沙箱配置或边界探针 |
| [native/host-command.sb](../native/host-command.sb) | Mac 原生助手、沙箱配置或边界探针 |
| [native/probes/host-command-boundary.c](../native/probes/host-command-boundary.c) | Mac 原生助手、沙箱配置或边界探针 |
| [native/probes/network-snapshot.swift](../native/probes/network-snapshot.swift) | Mac 原生助手、沙箱配置或边界探针 |
| [native/probes/shared-mount-id.c](../native/probes/shared-mount-id.c) | Mac 原生助手、沙箱配置或边界探针 |

## scripts

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [scripts/audit-browser-observables-evidence.mjs](../scripts/audit-browser-observables-evidence.mjs) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/audit-browser-observables.ts](../scripts/audit-browser-observables.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/audit-claude-feature-static.mjs](../scripts/audit-claude-feature-static.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-features.mjs](../scripts/audit-claude-features.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-fetch.mjs](../scripts/audit-claude-fetch.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-guest.py](../scripts/audit-claude-guest.py) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-hooks-errors.mjs](../scripts/audit-claude-hooks-errors.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-identity-permissions.mjs](../scripts/audit-claude-identity-permissions.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-indirect.mjs](../scripts/audit-claude-indirect.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-platform-fixture.py](../scripts/audit-claude-platform-fixture.py) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-report.mjs](../scripts/audit-claude-report.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-claude-static.mjs](../scripts/audit-claude-static.mjs) | CLI 环境审计脚本；非已安装 GUI 常驻功能 |
| [scripts/audit-local-delivery.ts](../scripts/audit-local-delivery.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/backup-browser-fixture.ts](../scripts/backup-browser-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/backup-import-worker.ts](../scripts/backup-import-worker.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/browser-context-fixture.ts](../scripts/browser-context-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/browser-media-fixture.ts](../scripts/browser-media-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/browser-webgpu-contexts-fixture.ts](../scripts/browser-webgpu-contexts-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/browser-webgpu-fixture.ts](../scripts/browser-webgpu-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/browser-webgpu-worker-canvas-fixture.ts](../scripts/browser-webgpu-worker-canvas-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/build-native.ts](../scripts/build-native.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/claude-local-fixture.ts](../scripts/claude-local-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/claude-tui-workflow.ts](../scripts/claude-tui-workflow.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/claude-wireguard-fixture.ts](../scripts/claude-wireguard-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/create-icon.mjs](../scripts/create-icon.mjs) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/deliver-normal-linux.ts](../scripts/deliver-normal-linux.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/diagnose-synthetic-cli-request.ts](../scripts/diagnose-synthetic-cli-request.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/diagnose-worker-fonts.ts](../scripts/diagnose-worker-fonts.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/disk-recovery-fault-worker.ts](../scripts/disk-recovery-fault-worker.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/disk-recovery-late-start-worker.ts](../scripts/disk-recovery-late-start-worker.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/doh-local-fixture.ts](../scripts/doh-local-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/guest-audio-proof.ts](../scripts/guest-audio-proof.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/inspect-current-vps-relay.ts](../scripts/inspect-current-vps-relay.ts) | 当前Mac到VPS中继只读诊断；--save保留已有回执 / 故障与最近系统日志，不改网络 |
| [scripts/inspect-desktop-state.ts](../scripts/inspect-desktop-state.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/inspect-retina-delivery.ts](../scripts/inspect-retina-delivery.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/install-managed-desktop-current.ts](../scripts/install-managed-desktop-current.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/install-runtime.ts](../scripts/install-runtime.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/lease-service-fixture.ts](../scripts/lease-service-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/mac-browser-fixture.cjs](../scripts/mac-browser-fixture.cjs) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/mac-chromium-launcher.sh](../scripts/mac-chromium-launcher.sh) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/packet-capture.ts](../scripts/packet-capture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/port-forward-fixture.py](../scripts/port-forward-fixture.py) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/prepare-grok-desktop-test.ts](../scripts/prepare-grok-desktop-test.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/preview-usability.ts](../scripts/preview-usability.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/probe-display-component.ts](../scripts/probe-display-component.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/proxy-transport-owner.ts](../scripts/proxy-transport-owner.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/rebuild-native.mjs](../scripts/rebuild-native.mjs) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/review-device-signals.ts](../scripts/review-device-signals.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/seed-protected-test-base.ts](../scripts/seed-protected-test-base.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/shared-migration-worker.ts](../scripts/shared-migration-worker.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/smoke-vm.ts](../scripts/smoke-vm.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/snapshot-restore-worker.ts](../scripts/snapshot-restore-worker.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/verify-access-latency-ui.ts](../scripts/verify-access-latency-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-backups-ui.ts](../scripts/verify-backups-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-backups.ts](../scripts/verify-backups.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-bridge.ts](../scripts/verify-bridge.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-contexts.ts](../scripts/verify-browser-contexts.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-gpu.ts](../scripts/verify-browser-gpu.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-home-delivery.ts](../scripts/verify-browser-home-delivery.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-install-evidence.ts](../scripts/verify-browser-install-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-install-recovery.ts](../scripts/verify-browser-install-recovery.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-media.ts](../scripts/verify-browser-media.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-monitor-evidence.ts](../scripts/verify-browser-monitor-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-monitor.ts](../scripts/verify-browser-monitor.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-profiles.ts](../scripts/verify-browser-profiles.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-sandbox-evidence.ts](../scripts/verify-browser-sandbox-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade-evidence.ts](../scripts/verify-browser-upgrade-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade-package.mjs](../scripts/verify-browser-upgrade-package.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade-packaged-evidence.ts](../scripts/verify-browser-upgrade-packaged-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade-packaged.ts](../scripts/verify-browser-upgrade-packaged.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade-ui.mjs](../scripts/verify-browser-upgrade-ui.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-browser-upgrade.ts](../scripts/verify-browser-upgrade.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-claude-client.ts](../scripts/verify-claude-client.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-claude-tui-evidence.ts](../scripts/verify-claude-tui-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-claude-tui-packaged.ts](../scripts/verify-claude-tui-packaged.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-claude-tui-wireguard.ts](../scripts/verify-claude-tui-wireguard.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-claude-tui.ts](../scripts/verify-claude-tui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-clean-rebuild.ts](../scripts/verify-clean-rebuild.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-client-egress-current.ts](../scripts/verify-client-egress-current.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-day-workflow-evidence.ts](../scripts/verify-day-workflow-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-day-workflow.ts](../scripts/verify-day-workflow.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-delivery-controls.ts](../scripts/verify-delivery-controls.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop-crash-evidence.ts](../scripts/verify-desktop-crash-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop-crash.ts](../scripts/verify-desktop-crash.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop-display-separation.ts](../scripts/verify-desktop-display-separation.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop-display-ui.ts](../scripts/verify-desktop-display-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop-line-fault.ts](../scripts/verify-desktop-line-fault.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-desktop.mjs](../scripts/verify-desktop.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-disk-recovery-faults-evidence.ts](../scripts/verify-disk-recovery-faults-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-disk-recovery-faults.ts](../scripts/verify-disk-recovery-faults.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-disk-recovery-startup-evidence.ts](../scripts/verify-disk-recovery-startup-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-disk-recovery-startup.ts](../scripts/verify-disk-recovery-startup.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-domain-network-evidence.ts](../scripts/verify-domain-network-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-domain-network.ts](../scripts/verify-domain-network.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-egress-probe-evidence.ts](../scripts/verify-egress-probe-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-egress-quorum.ts](../scripts/verify-egress-quorum.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-egress-ui.ts](../scripts/verify-egress-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-egress.ts](../scripts/verify-egress.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-encrypted-upstream-evidence.ts](../scripts/verify-encrypted-upstream-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-encrypted-upstream.ts](../scripts/verify-encrypted-upstream.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-fixed-display-ui.ts](../scripts/verify-fixed-display-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-audio-ui.ts](../scripts/verify-guest-audio-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-browser.ts](../scripts/verify-guest-browser.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-capacity-evidence.ts](../scripts/verify-guest-capacity-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-capacity.ts](../scripts/verify-guest-capacity.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-disk-growth-evidence.ts](../scripts/verify-guest-disk-growth-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-disk-growth.ts](../scripts/verify-guest-disk-growth.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-exchange-actual.ts](../scripts/verify-guest-exchange-actual.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-workspace-actual.ts](../scripts/verify-guest-workspace-actual.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-guest-workspace-ui.ts](../scripts/verify-guest-workspace-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-commands-evidence.ts](../scripts/verify-host-commands-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-commands-packaged-evidence.ts](../scripts/verify-host-commands-packaged-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-commands-packaged.ts](../scripts/verify-host-commands-packaged.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-commands.ts](../scripts/verify-host-commands.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-network-desktop.ts](../scripts/verify-host-network-desktop.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-network-native.ts](../scripts/verify-host-network-native.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-power-desktop.ts](../scripts/verify-host-power-desktop.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-power-vm-evidence.ts](../scripts/verify-host-power-vm-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-power-vm.ts](../scripts/verify-host-power-vm.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-sleep-actual-evidence.ts](../scripts/verify-host-sleep-actual-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-host-sleep-actual.ts](../scripts/verify-host-sleep-actual.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-hostname-security.ts](../scripts/verify-hostname-security.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-https-ui.ts](../scripts/verify-https-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-installed-line.ts](../scripts/verify-installed-line.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-installed-usability.ts](../scripts/verify-installed-usability.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-lab.mjs](../scripts/verify-lab.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-layout-delivery.ts](../scripts/verify-layout-delivery.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-lease.ts](../scripts/verify-lease.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-local-line.ts](../scripts/verify-local-line.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-mac-browser.ts](../scripts/verify-mac-browser.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-mac-chromium.ts](../scripts/verify-mac-chromium.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-mac-policy.ts](../scripts/verify-mac-policy.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-managed-desktop-ui.ts](../scripts/verify-managed-desktop-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-managed-desktop.ts](../scripts/verify-managed-desktop.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-native-lab.mjs](../scripts/verify-native-lab.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-network-destinations-delivery.ts](../scripts/verify-network-destinations-delivery.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-network-destinations-ui.ts](../scripts/verify-network-destinations-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-network-observations-delivery.ts](../scripts/verify-network-observations-delivery.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-networkd-policy.ts](../scripts/verify-networkd-policy.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-normal-linux-package.mjs](../scripts/verify-normal-linux-package.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-normal-linux.ts](../scripts/verify-normal-linux.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-package.ts](../scripts/verify-package.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-packaged-backup-browser.ts](../scripts/verify-packaged-backup-browser.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-packaged-guest-browser.mjs](../scripts/verify-packaged-guest-browser.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-packaged-workflow-evidence.ts](../scripts/verify-packaged-workflow-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-packaged-workflow.ts](../scripts/verify-packaged-workflow.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-port-forwards.ts](../scripts/verify-port-forwards.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-protection-events-ui.ts](../scripts/verify-protection-events-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-security.ts](../scripts/verify-security.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-shared-migration-evidence.ts](../scripts/verify-shared-migration-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-shared-mounts-ui-evidence.ts](../scripts/verify-shared-mounts-ui-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-shared-mounts-ui.ts](../scripts/verify-shared-mounts-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-shared-mounts.ts](../scripts/verify-shared-mounts.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-snapshots.ts](../scripts/verify-snapshots.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-socks-captures.ts](../scripts/verify-socks-captures.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-socks-upstream.ts](../scripts/verify-socks-upstream.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-storage-capacity-evidence.ts](../scripts/verify-storage-capacity-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-storage-capacity.ts](../scripts/verify-storage-capacity.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-sustained-diagnostic-failure.ts](../scripts/verify-sustained-diagnostic-failure.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-sustained-network-evidence.ts](../scripts/verify-sustained-network-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-sustained-network.ts](../scripts/verify-sustained-network.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-transparent.ts](../scripts/verify-transparent.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-ui.mjs](../scripts/verify-ui.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-usability-evidence.ts](../scripts/verify-usability-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-usability-runtime.ts](../scripts/verify-usability-runtime.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-webgpu-device-loss-host-evidence.ts](../scripts/verify-webgpu-device-loss-host-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-webgpu-evidence.ts](../scripts/verify-webgpu-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-webgpu-host.ts](../scripts/verify-webgpu-host.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wireguard-captures.ts](../scripts/verify-wireguard-captures.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wireguard-faults-evidence.ts](../scripts/verify-wireguard-faults-evidence.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wireguard-runtime.ts](../scripts/verify-wireguard-runtime.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wireguard-ui.ts](../scripts/verify-wireguard-ui.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wireguard.ts](../scripts/verify-wireguard.ts) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/verify-wizard-ui.mjs](../scripts/verify-wizard-ui.mjs) | 专项验证 / 证据复核；结果以报告限定范围为准 |
| [scripts/webgpu-candidate.ts](../scripts/webgpu-candidate.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/webgpu-device-loss-fixture.ts](../scripts/webgpu-device-loss-fixture.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/webgpu-device-loss-measurement.ts](../scripts/webgpu-device-loss-measurement.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/wireguard-faults.ts](../scripts/wireguard-faults.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/wireguard-fixture.py](../scripts/wireguard-fixture.py) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/wireguard-packaged-workloads.ts](../scripts/wireguard-packaged-workloads.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/wireguard-workloads.ts](../scripts/wireguard-workloads.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/worker-canvas-measurement.ts](../scripts/worker-canvas-measurement.ts) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/write-build-info.mjs](../scripts/write-build-info.mjs) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |
| [scripts/write-project-files.py](../scripts/write-project-files.py) | 构建、检查、夹具或开发辅助；运行前查看脚本和对应方案 |

## server

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [server/acceptance-lab.ts](../server/acceptance-lab.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/backups.ts](../server/backups.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/bridge-guest.ts](../server/bridge-guest.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-install-transaction.ts](../server/browser-install-transaction.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-profile-transaction.ts](../server/browser-profile-transaction.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-profile-version.ts](../server/browser-profile-version.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-releases.ts](../server/browser-releases.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-reset.ts](../server/browser-reset.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser-startpage.ts](../server/browser-startpage.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/browser.ts](../server/browser.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/disk-recovery.ts](../server/disk-recovery.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/egress.ts](../server/egress.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/errors.ts](../server/errors.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-audio.ts](../server/guest-audio.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-browser-runtime.ts](../server/guest-browser-runtime.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-browser-sandbox.ts](../server/guest-browser-sandbox.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-browser.ts](../server/guest-browser.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-desktop.ts](../server/guest-desktop.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-disk.ts](../server/guest-disk.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-display-runtime.ts](../server/guest-display-runtime.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-display-session.ts](../server/guest-display-session.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-display.ts](../server/guest-display.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-exchange.ts](../server/guest-exchange.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-hostname.ts](../server/guest-hostname.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-lease.ts](../server/guest-lease.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-links.ts](../server/guest-links.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-mounts.ts](../server/guest-mounts.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-networkd.ts](../server/guest-networkd.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-privileges.ts](../server/guest-privileges.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-storage.ts](../server/guest-storage.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-task.ts](../server/guest-task.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/guest-window.ts](../server/guest-window.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/host-bridge.ts](../server/host-bridge.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/host-network.ts](../server/host-network.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/import-seed.ts](../server/import-seed.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/latency.ts](../server/latency.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/lima-config.ts](../server/lima-config.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/local-check.ts](../server/local-check.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/local-proxy.ts](../server/local-proxy.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/mac-policy.ts](../server/mac-policy.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/main.ts](../server/main.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/manager.ts](../server/manager.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/mock-messages.ts](../server/mock-messages.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/network-guard.ts](../server/network-guard.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/network-observations.ts](../server/network-observations.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/probe-assets.ts](../server/probe-assets.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/process.ts](../server/process.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/protected-base.ts](../server/protected-base.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/proxy-transport.ts](../server/proxy-transport.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/resource-budget.ts](../server/resource-budget.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/runtime.ts](../server/runtime.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/service.ts](../server/service.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/snapshots.ts](../server/snapshots.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/store.ts](../server/store.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/terminal.ts](../server/terminal.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/transparent-network.ts](../server/transparent-network.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/ui-session.ts](../server/ui-session.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/validation.ts](../server/validation.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/vnc-display.ts](../server/vnc-display.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/wireguard-network.ts](../server/wireguard-network.ts) | 本机服务、VM、网络、权限或恢复模块 |
| [server/wireguard.ts](../server/wireguard.ts) | 本机服务、VM、网络、权限或恢复模块 |

## shared

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [shared/browser-home.ts](../shared/browser-home.ts) | 公共类型、校验、配置或版本 |
| [shared/guest-audio.ts](../shared/guest-audio.ts) | 公共类型、校验、配置或版本 |
| [shared/guest-desktop.ts](../shared/guest-desktop.ts) | 公共类型、校验、配置或版本 |
| [shared/guest-display.ts](../shared/guest-display.ts) | 公共类型、校验、配置或版本 |
| [shared/guest-exchange.ts](../shared/guest-exchange.ts) | 公共类型、校验、配置或版本 |
| [shared/latency.ts](../shared/latency.ts) | 公共类型、校验、配置或版本 |
| [shared/native.d.ts](../shared/native.d.ts) | 公共类型、校验、配置或版本 |
| [shared/network-observations.ts](../shared/network-observations.ts) | 公共类型、校验、配置或版本 |
| [shared/novnc.d.ts](../shared/novnc.d.ts) | 公共类型、校验、配置或版本 |
| [shared/protection-events.ts](../shared/protection-events.ts) | 公共类型、校验、配置或版本 |
| [shared/stun.d.ts](../shared/stun.d.ts) | 公共类型、校验、配置或版本 |
| [shared/types.ts](../shared/types.ts) | 公共类型、校验、配置或版本 |
| [shared/version.ts](../shared/version.ts) | 公共类型、校验、配置或版本 |

## src

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [src/AccessLatency.tsx](../src/AccessLatency.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/App.tsx](../src/App.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/BackupDialog.tsx](../src/BackupDialog.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/BridgePanel.tsx](../src/BridgePanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/DesktopPanel.tsx](../src/DesktopPanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/GuestAudio.tsx](../src/GuestAudio.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/GuestBrowserView.tsx](../src/GuestBrowserView.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/GuestExchangePanel.tsx](../src/GuestExchangePanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/HelpPanel.tsx](../src/HelpPanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/LabPanel.tsx](../src/LabPanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/NetworkActivity.tsx](../src/NetworkActivity.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/NetworkWizard.tsx](../src/NetworkWizard.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/ProtectionBanner.tsx](../src/ProtectionBanner.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/ProtectionEvents.tsx](../src/ProtectionEvents.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/SetupChecklist.tsx](../src/SetupChecklist.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/SnapshotsPanel.tsx](../src/SnapshotsPanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/TerminalPanel.tsx](../src/TerminalPanel.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/api.ts](../src/api.ts) | 前端界面、交互、样式或 API 调用 |
| [src/components.tsx](../src/components.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/forms.tsx](../src/forms.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/guest-audio-player.ts](../src/guest-audio-player.ts) | 前端界面、交互、样式或 API 调用 |
| [src/guest-audio.css](../src/guest-audio.css) | 前端界面、交互、样式或 API 调用 |
| [src/liquid.css](../src/liquid.css) | 前端界面、交互、样式或 API 调用 |
| [src/main.tsx](../src/main.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/panels.tsx](../src/panels.tsx) | 前端界面、交互、样式或 API 调用 |
| [src/styles.css](../src/styles.css) | 前端界面、交互、样式或 API 调用 |

## tests

| 文件（相对项目根目录） | 用途 |
| --- | --- |
| [tests/backups.test.ts](../tests/backups.test.ts) | 单元 / API / 回归测试文件 |
| [tests/bridge-config.test.ts](../tests/bridge-config.test.ts) | 单元 / API / 回归测试文件 |
| [tests/bridge.test.ts](../tests/bridge.test.ts) | 单元 / API / 回归测试文件 |
| [tests/browser-home.test.ts](../tests/browser-home.test.ts) | 单元 / API / 回归测试文件 |
| [tests/browser-monitor.test.ts](../tests/browser-monitor.test.ts) | 单元 / API / 回归测试文件 |
| [tests/browser-profile-version.test.ts](../tests/browser-profile-version.test.ts) | 单元 / API / 回归测试文件 |
| [tests/browser-stable-package.test.ts](../tests/browser-stable-package.test.ts) | 单元 / API / 回归测试文件 |
| [tests/browser-upgrade.test.ts](../tests/browser-upgrade.test.ts) | 单元 / API / 回归测试文件 |
| [tests/core.test.ts](../tests/core.test.ts) | 单元 / API / 回归测试文件 |
| [tests/desktop-display-separation.test.ts](../tests/desktop-display-separation.test.ts) | 单元 / API / 回归测试文件 |
| [tests/disk-recovery.test.ts](../tests/disk-recovery.test.ts) | 单元 / API / 回归测试文件 |
| [tests/egress-probe-dns.test.ts](../tests/egress-probe-dns.test.ts) | 单元 / API / 回归测试文件 |
| [tests/egress-quorum.test.ts](../tests/egress-quorum.test.ts) | 单元 / API / 回归测试文件 |
| [tests/egress.test.ts](../tests/egress.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-audio-service.test.ts](../tests/guest-audio-service.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-audio.test.ts](../tests/guest-audio.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-browser-initialization.test.ts](../tests/guest-browser-initialization.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-browser-lifecycle.test.ts](../tests/guest-browser-lifecycle.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-browser-runtime.test.ts](../tests/guest-browser-runtime.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-browser-sandbox.test.ts](../tests/guest-browser-sandbox.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-browser.test.ts](../tests/guest-browser.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-desktop.test.ts](../tests/guest-desktop.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-display-session.test.ts](../tests/guest-display-session.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-display.test.ts](../tests/guest-display.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-exchange.test.ts](../tests/guest-exchange.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-handoff.test.ts](../tests/guest-handoff.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-hostname.test.ts](../tests/guest-hostname.test.ts) | 单元 / API / 回归测试文件 |
| [tests/guest-task.test.ts](../tests/guest-task.test.ts) | 单元 / API / 回归测试文件 |
| [tests/host-commands.test.ts](../tests/host-commands.test.ts) | 单元 / API / 回归测试文件 |
| [tests/host-network.test.ts](../tests/host-network.test.ts) | 单元 / API / 回归测试文件 |
| [tests/host-power.test.ts](../tests/host-power.test.ts) | 单元 / API / 回归测试文件 |
| [tests/latency.test.ts](../tests/latency.test.ts) | 单元 / API / 回归测试文件 |
| [tests/lease.test.ts](../tests/lease.test.ts) | 单元 / API / 回归测试文件 |
| [tests/mock-messages.test.ts](../tests/mock-messages.test.ts) | 单元 / API / 回归测试文件 |
| [tests/monitor.test.ts](../tests/monitor.test.ts) | 单元 / API / 回归测试文件 |
| [tests/network-observations.test.ts](../tests/network-observations.test.ts) | 单元 / API / 回归测试文件 |
| [tests/networkd-policy.test.ts](../tests/networkd-policy.test.ts) | 单元 / API / 回归测试文件 |
| [tests/port-forwards.test.ts](../tests/port-forwards.test.ts) | 单元 / API / 回归测试文件 |
| [tests/protection-events.test.ts](../tests/protection-events.test.ts) | 单元 / API / 回归测试文件 |
| [tests/proxy-tls.test.ts](../tests/proxy-tls.test.ts) | 单元 / API / 回归测试文件 |
| [tests/proxy-transport.test.ts](../tests/proxy-transport.test.ts) | 单元 / API / 回归测试文件 |
| [tests/resources.test.ts](../tests/resources.test.ts) | 单元 / API / 回归测试文件 |
| [tests/security.test.ts](../tests/security.test.ts) | 单元 / API / 回归测试文件 |
| [tests/service.test.ts](../tests/service.test.ts) | 单元 / API / 回归测试文件 |
| [tests/shared-mounts.test.ts](../tests/shared-mounts.test.ts) | 单元 / API / 回归测试文件 |
| [tests/snapshots.test.ts](../tests/snapshots.test.ts) | 单元 / API / 回归测试文件 |
| [tests/ui-session.test.ts](../tests/ui-session.test.ts) | 单元 / API / 回归测试文件 |
| [tests/usability.test.ts](../tests/usability.test.ts) | 单元 / API / 回归测试文件 |
| [tests/viewer-shutdown.test.ts](../tests/viewer-shutdown.test.ts) | 单元 / API / 回归测试文件 |
| [tests/webgpu-device-loss.test.ts](../tests/webgpu-device-loss.test.ts) | 单元 / API / 回归测试文件 |
| [tests/webgpu-evidence.test.ts](../tests/webgpu-evidence.test.ts) | 单元 / API / 回归测试文件 |
| [tests/webgpu-worker-canvas.test.ts](../tests/webgpu-worker-canvas.test.ts) | 单元 / API / 回归测试文件 |
| [tests/wireguard.test.ts](../tests/wireguard.test.ts) | 单元 / API / 回归测试文件 |

## 单独管理的目录 / 文件

| 位置 | 用途与范围 |
| --- | --- |
| `node_modules/` | 开发依赖，按 package-lock 安装；不是应用手写源码 |
| `dist/`、`dist-server/` | 前端和服务端编译产物，由构建生成 |
| `native/bin/` | 已编译的本机助手；由原生构建步骤生成 |
| `build-info.json` | 对构建内容计算出的标识与构建时间 |
| `release/` | 桌面候选与历史副本；当前交付路径见总览 |
| `test-results/` | 原始报告、截图、抓包、日志与受校验审计包；不是全部公开分享材料 |
| `.mu-data/` | 隔离的源码开发数据；使用时才生成，不与正式试用目录混用 |
| `/Users/staff/.mucodesandbox/` | 真实环境配置、数据库、密钥、VM 磁盘与运行组件 |
| `/Users/staff/Applications/MuCodeSandbox.app` | 已安装的本机应用副本 |
| `/Users/staff/Desktop/MuCodeSandbox.app` | 指向已安装副本的桌面快捷链接 |

## 更新与核对

在项目根目录运行 `python3 scripts/write-project-files.py` 可重新生成本清单。
这一步只读取工作区文件名与大小并写文档，不启动 VM、不构建或下载依赖。
统计数据见 [project-file-stats.json](project-file-stats.json)。生成的清单与统计
自身不计入文件字节总量，避免自引用导致统计不断变化。
