# MuCodeSandbox Completion Plan

The user authorized continued development through completion. First-round
acceptance must use synthetic accounts, controlled services and mock model
responses. Claude login and paid model calls are excluded from this phase.

On 2026-10-09 the user selected the Linux VM route for the next delivery,
covering the browser and Claude Code first. Native macOS Desktop integration,
macOS guests and a signed Apple Network Extension remain later work, not
completed features. The Linux browser must keep Chromium's renderer sandbox
enabled and report the actual Linux platform and hardware capabilities.

## Work Queue

| Work | Status | Acceptance |
| --- | --- | --- |
| Linux TCP / DoH transparent network | Latest b0cd06d full transparent workflow plus actual two-VM WireGuard browser/CLI, peer loss/recovery/restart passed independent review at 14:31 UTC | Real VM, packet capture; remaining fault/long-duration/public-route coverage still separate |
| Browser inside protected Linux VM | Actual display, input, sandbox, identity, proxy-fault capture and dual-profile persistence passed; fresh A/B cold installation seven stages passed after preserving networkd policy routes | Real headed Chromium, authenticated remote display, sandbox enabled, identity / cookies / network failures |
| Encrypted proxy upstream | Real Linux VM and bidirectional physical capture passed | HTTPS CONNECT with verified server name / CA, plaintext positive control, physical capture, wrong CA / name / credentials and loss fail closed |
| Final exit constraint | Host gates / quarantine and guest kernel expiry / closed boot passed on real VMs; actual public routing pending | Explicit approval, closed business before measurement, SIGKILL and graceful revoke verified. Add sleep / wake and real public source tests; polling is not a per-connection guarantee |
| Account-free acceptance lab | Verified locally | Actual DNS / STUN positive controls, synthetic login, mock streaming task and mobile UI |
| Firewall integrity and continuous monitoring | Rule tampering verified; more faults pending | Rule insertion, route / DNS drift, stopped guard; quarantine and terminal revocation |
| Configurable DNS and proxy compatibility | Controlled HTTP / HTTPS / SOCKS5 and configurable DoH actually verified | Wrong credentials / CA / name, no-auth SOCKS, special characters, service loss and restart; commercial lines and SOCKS browser / CLI still pending |
| Resource budgets and port preflight | Verified | Concurrent starts, occupied ports, cancellation and recovery |
| Protected first-boot image | Latest b0cd06d actual Electron fresh/restart/import boot captures independently verified against three distinct live kernel boot IDs; networkd restart preserves the completed capture | Pinned authenticated manifest, bounded boot capture, no initial unapproved output; legacy backup migration still needs explicit coverage |
| Development-user privilege separation | Fresh first mount / reboot, unsafe legacy migration, SIGKILL recovery and native-data preservation passed. Source and 5558c78 compiled modules passed unsafe snapshot restore / automatic maintenance. Latest actual Electron UI fresh-directory mounts, effective shared positive control / restoration, permission demotion and independent captures passed | Other old-user mappings, remaining interruption windows and power loss remain; direct sudo denials alone are not complete escalation coverage |
| Mac managed-process network enforcement | Experimental process test passed; Chromium conflict reproduced | Native policy and children; TCP, UDP, IPv6, proxy failure; Chromium sandbox must remain enabled |
| Browser identity consistency | Seven contexts and six stages passed; protected software WebGL / WebGL2 and real startup failure / recovery verified in source and compiled package | Truthful platform, font-ready rendering, offline audio, per-thread seccomp and physical captures; late Worker font registration and long-term performance pending |
| Running-browser protection | Automatic 8-second checks and managed-access checks implemented; source and compiled package each passed actual cgroup fault, scope, viewer / terminal / bridge revocation, VM shutdown and recovery; raw evidence independently verified | Sampled detection with measured 10–11-second fault-to-stop; long-running / sleep tests pending, no root-compromise or Mac coverage claim |
| WebGPU computation and presentation | Official-browser candidate computation / real Worker canvas and protection evidence retained; injected GPU crash recovery and late Worker font limitations remain. Candidate is not in production | No custom-engine fixes: preserve upstream compatibility failures, evaluate official releases / supported settings and safety before optional adoption. Core delivery does not depend on this candidate |
| Host capability bridge | b0cd06d actual UI/fresh VM grants, fixed commands, repeated listings, revoke/stop and blocked-command shutdown in 143 ms passed independent review at 14:16 UTC. Ten packaged native tests include signal-denial cleanup; 123 total tests passed | No arbitrary shell; hard-linked / large repositories, worktrees and submodules are outside current compatibility; long-term/platform faults remain |
| Claude Desktop adaptation | Deferred by the user on 2026-10-10; excluded from current delivery | Do not implement or use existing Desktop accounts in this phase; resume only when the user schedules it |
| Snapshot, restore and migration | Actual interruption recovery and independent-store encrypted browser backup passed. Restore invalidates shared-mount approvals / migration journals before disk mutation; source and 5558c78 compiled modules passed unsafe-disk rollback / automatic maintenance. Latest 5558c78 Electron UI snapshot / encrypted import, browser persistence and old bridge grant rejection passed | Latest package all transaction interruptions, second Mac, full capacity and power loss remain pending; unsafe legacy-disk module tests run under Node, separate from the Electron workflow |
| Distribution and other platforms | Local test build selected by user | No Apple certificate / account presently; signed Network Extension and Windows / Intel validation need external prerequisites |

## Architecture Decisions

2026-10-10 user constraint: use official browser binaries and avoid browser
engine forks unless essential requirements demonstrably cannot be met by
supported configuration / official releases and the user explicitly accepts
the maintenance cost. Custom build / source downloads, engine patches,
scripts and dedicated build VM have been removed. Preserve historical
research reports and the late Worker font and injected GPU crash
failures as upstream compatibility limits; neither is evidence of account
suspension or a prerequisite for VM / network isolation. Continue core
isolation, official-browser upgrade validation and product work. An upgrade
must retain independent profiles and verify sandbox / egress / graphics
before adoption; an automatic browser updater has not been implemented.

Native-build history is archived in `browser-native-patch-validation.md`;
it is not an active delivery dependency. Do not resume that work from old
logs or source snapshots.

Extend the existing local TypeScript / Electron / Lima architecture. Do not
replace the working Linux data path. The lab runs on a separate loopback
listener with synthetic state, never on the authenticated management origin.
DNS and STUN use protocol libraries. Receipts report what was actually tested,
including unavailable or untested checks; absence of packets alone is not a
pass without a positive control.

Guard inspection compares the kernel rules against the exact rules approved by
the host, ignoring only changing counters and kernel handles. The host owns the
expected fingerprint; the guest cannot approve its own changed rules. The
manager monitors strict environments independently of UI polling. Failure
closes terminal sessions and stops the VM, then records an error. This reduces
accidental bypass but does not replace a boundary outside a root-controlled
guest.

Mac network enforcement must cover the actual network process and descendants.
Browser proxy settings or JavaScript overrides do not count as enforcement.
Apple signing and entitlements must be checked before claiming a distributable
Network Extension. Local experimental mechanisms must remain explicitly
distinguished from a verified production provider.

## Evidence Rules

- Keep running code, tests and documentation consistent.
- Use disposable environments for destructive fault and restore tests.
- Never use a real Claude account as a safety probe.
- Mark external prerequisites precisely; do not label unexecuted checks passed.
- Continue independent implementation when a particular platform or external
  credential is unavailable.

## Revised Delivery Order

1. Latest 5558c78 Electron package: fresh-directory transparent workflow passed
   on 2026-10-10 at 09:16 UTC, including official browser, account-free official
   CLI, restricted file bridge, UI snapshot and encrypted import. A separate
   fresh-directory actual UI shared-mount workflow passed at 09:47 UTC, with
   first mount, reboot, effective positive control, permission demotion and
   independently decoded raw captures. Continue latest-package tunnel mode,
   other old-user mappings and remaining migration / transaction faults.
   Restricted host Git commands and the repeated directory-listing fix now
   passed actual 74fda9a Electron UI / fresh VM acceptance at 13:33 UTC:
   eight packaged native tests, revoke/stop and active-command shutdown in
   203 ms, independent source/native identity and three raw captures verified.
   No accounts or paid calls; disposable resources removed. This does not
   transfer the older full-workflow or tunnel results to the latest package.
   Latest b0cd06d package full transparent-mode UI/VM workflow passed at
   14:13:54 UTC, independent evidence at 14:14:09: official browser and CLI,
   file/fixed-command grants, snapshots/encrypted import, five raw captures,
   three distinct live kernel boot IDs, all disposable resources removed.
   An earlier 74fda9a observation run reused its imported first-boot pcap;
   independent review rejected it. New per-boot capture fixes this evidence
   defect and retains networkd operation. Ten native tests and 123 unit tests
   passed after fixing a real exit-callback signal error/cleanup hang.
   Latest active-command shutdown also passed at 14:16 UTC in 143 ms with
   no surviving group members and three independently decoded raw captures.
   Latest b0cd06d two-VM WireGuard browser/CLI workflow, actual page fetch
   peer-loss positive/negative/recovery controls, reboot persistence and
   four raw captures passed at 14:31 UTC with independent review. Cold
   installation precedes local-only gateway restriction; no model account
   or paid calls. Own VMs/base/data removed. No long-term/all-fault claim.
   Latest b0cd06d actual Electron UI fresh shared-mount acceptance passed
   at 14:46 UTC, independent review at 14:47 UTC: effective identity controls,
   permission demotion, three distinct live boot IDs and six raw captures,
   all compiled backend modules and PNGs verified, owned resources removed.
   The earlier screenshot-timeout run remains failed. Legacy migration and
   unsafe snapshot restoration are separate acceptance scopes.
   Latest b0cd06d packaged-module real legacy migration, actual worker SIGKILL
   with access refusal/quarantine/retry, unsafe snapshot restoration with
   revoked host trust and automatic no-export repair passed at 14:49 UTC.
   Independent evidence verifies all 40 modules, source/config/ELF snapshots,
   effective identity positive controls and owned-resource cleanup. This runs
   modules under Node, without Electron UI or physical captures. Other user
   mappings and remaining interruption windows are still pending.
   Continue remaining shared-migration mappings and tunnel faults
   and fault/long-duration coverage; do not inherit historical package scopes.
2. Cover sustained operation, service interruption and measured lease expiry;
   add controlled sleep / network-change tests while respecting the user's
   running applications and resource limits. Keep a cleanup receipt for every
   disposable VM and keep accounts / paid models out of first-round tests.
   Latest b0cd06d packaged-module real VM sustained network acceptance passed
   at 15:20:43 UTC and independent review at 15:21:02 UTC: two five-minute
   stable phases totaling 609,771 ms, raw TCP/stream receipts, actual proxy
   listener loss and direct-bypass rejection, networkd restart/DHCP renewal,
   tunnel-service failure auto-quarantine and restart recovery. Four raw
   captures have zero unapproved output; all 40 modules and source/artifacts
   verified; own resources removed. DNS requests are deliberately rejected
   by the local fixture and counted, not successful resolution acceptance.
   An earlier incorrect DNS assertion remains failed. Day-long operation,
   browser/UI, real routes, Mac sleep/Wi-Fi and more fault modes remain.
   Real guest controlled TLS DoH/system resolver acceptance then passed at
   15:39 UTC: 22 distinct domain lookups/HTTP receipts, three-minute fresh
   domain phase, three explicit untrusted-CA/service-outage/wrong-name fault
   windows, NXDOMAIN, physical DNS bypass rejection, networkd/DHCP and DNS
   recovery. Six raw captures have zero unapproved output; all 40 modules,
   certificates, receipts and resources independently verified. A prior
   verifier falsely rejected pending DNS retries after recovery; its rejection
   remains archived and the entire workflow reran with measured fault windows.
   Test CA only existed in own temporary guest; no Mac trust change. This is
   separate from browser/public-resolver/day-long acceptance.
3. Add official-browser upgrade / recovery with protected profile migration,
   integrity checks and safety acceptance before adoption. Preserve known
   upstream media failures without treating a browser fork as mandatory.
   Source same-version installation transaction passed actual five-point
   installer SIGKILL recovery, profile / sandbox / network observations and
   independently decoded captures on 2026-10-10 at 10:15 UTC. Cross-version
   checkpoint / rollback, approved version selection and UI are now implemented.
   Actual source-runtime official 153-to-156 adoption, changed-data rollback,
   checkpoint process SIGKILL recovery and VM restart passed at 10:46 UTC;
   independent raw-capture verification passed at 10:47 UTC. Source-built UI
   with fixture version state passed desktop/mobile checks. New Electron
   package 1e2831a passed fresh-VM actual UI recovery / update, symlink /
   corrupt-checkpoint / malformed-journal rejection, two official versions,
   reboot persistence and independent first-boot / task captures at 12:36 UTC.
   The previous version was prepared using the source installer. Fixed a real
   active-viewer shutdown deadlock; regression tests and actual application
   exit in 652 ms passed. Other interruption windows and capacity /
   power-loss tests remain. Remote SIGKILL observation timed out boundedly;
   immediate remote management-process exit has not been proved.
4. Complete configuration / status workflows. The user explicitly deferred
   Claude Desktop integration; keep it out of this delivery. Actual Mac
   egress enforcement, Apple permissions and real residential routes remain
   separately reported requirements.
5. Complete clean install, upgrade, recovery and distribution validation.
   Apple signatures, second-device tests and other platforms remain explicit
   outstanding conditions. Do not mark the whole project complete early.
