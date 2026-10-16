# Historical Browser Engine Research (Retired 2026-10-10)

This is an archived investigation, not an active implementation plan. The
user authorized removal of its checkout, patches, tools, build scripts and
dedicated build VM. Commands and paths below describe historical experiments
and must not be executed as current instructions. Source copies and results
in `test-results/` remain historical evidence; no engine patch was shipped.

## User Decision: Official Browser Releases

On 2026-10-10 the user rejected routine browser-engine modification because
it creates a large build and an ongoing security-update maintenance burden.
Use official browser binaries by default. The existing source patches are
research artifacts; they are uncompiled and are not shipped. Do not resume
downloads, custom compilation or adoption without a new explicit user decision
after establishing that supported configuration and official releases cannot
meet an essential requirement. The native build / source preparation scripts
now refuse execution; the Linux script retains a resource-only preflight.

Ordinary browser use does not require the two proposed engine repairs. Late
Worker font registration and original Worker canvas recovery after an injected
GPU-process crash remain observed upstream compatibility failures. Keep their
failed results; do not turn off assertions or call them fixed. No evidence
connects either test failure to account suspension. They are not prerequisites
for the network, VM or profile isolation work.

The latest actual Linux dependency sync completed on 2026-10-10 at
07:18:35 UTC, pinned HEAD and the seven patched-source hashes were checked,
and post-sync scope passed at 07:24:58 UTC. At 07:37 UTC the hooks task was
explicitly cancelled while investigating disk / memory use, not completed.
The original owner saved its failed report and actually stopped the dedicated
VM; the retained historical report
`chromium-linux/2026-10-10T06-59-56-849Z-prepare.json` has `dependenciesComplete=true`,
`buildVmStopped=true` and `browserNativeCompiled=false`. An independently
executed x64 gperf generated C that native ARM64 GCC compiled and ran with
positive / negative keyword tests (`chromium-gperf.json`). This is a tool
prerequisite only, not browser compilation or font / recovery acceptance.

The Linux resource guard additionally reserves 120 GiB, budgets volume
free-space reduction by stage, and checks physical RAM and system swap.
These are conservative project policies, not official Chromium requirements
or proof that other applications did not consume disk / memory. Five focused
tests include actual host child termination and SIGTERM cleanup. The actual
preflight rejects this Mac's current resources without starting a VM. That
does not verify the new SIGTERM path across an actual build-VM lifecycle;
the earlier real VM stop used its existing guest cancellation endpoint.

Storage accounting on this Mac also differs by API: filesystem free space
was about 159 GB while Foundation's available capacity for important usage
was about 252 GB. The latter can include reclaimable capacity. Do not
describe the difference from the user's 250.96 GB screenshot as proven
project consumption. No Data-volume snapshots were listed. APFS cloned
source directories share data, so their `du` totals cannot be added as
unique physical usage. The original 33 GiB tree contains 27 GiB under
`third_party`, not 33 GiB of MuCodeSandbox application code.

## Scope

Two native source candidates address observed failures: late Worker font
registration keeps the fallback font, and a real GPU process crash leaves
the original transferred Worker canvases blank. The latter also reproduces
in ordinary Mac Chrome. These failures remain unresolved in the installed
browser and every existing MuCodeSandbox package.

The source target is Chromium 156.0.8078.4, commit
`f842f52ef39fd97b449eb27cff414bf05a98ddce`, tree
`0373970347d8fcc1d75f59c022ddcfb551f738e3`.

## Candidates

`native/chromium/worker-font-invalidation.patch` implements the existing
CSSFontSelector pattern in OffscreenFontSelector: weak clients, registration
and removal, invalidation callbacks with a stable client snapshot, and
garbage-collector tracing. It retains the original font family and native
FontFace / Canvas APIs. The existing same-family, late-load media gate must
still pass after compilation; this source change alone does not prove it.

`native/chromium/offscreen-frame-sink-loss.patch` observes the actual Mojo
frame-sink disconnect. The next OffscreenCanvas draw recreates its dispatcher
and placeholder client, preserving the Worker and original DOM canvas. It
also includes a native regression with two unacknowledged frames and a real
mock Mojo disconnection. That C++ regression has not been compiled or run.
The missing disconnect handler and retained dispatcher support this candidate
but do not prove the sole cause of the observed blank canvas.

The separate `offscreen-frame-sink-callback-lifetime.patch` follows the
frame-sink candidate. Lazy dispatcher replacement can happen within the
client callback; accessing dispatcher members afterward can use a deleted
object. The follow-up closes the old receiver / embedder on loss, rejects
late frames, and checks a weak pointer after real and synthetic frame callbacks.
Two C++ regressions destroy the dispatcher from those callbacks. Neither
regression has been compiled or run. The actual test target is
`blink_platform_unittests`, established from the pinned platform BUILD.gn.

Primary pinned code:

- [CSSFontSelector invalidation](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/css/css_font_selector.cc)
- [OffscreenFontSelector](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/css/offscreen_font_selector.cc)
- [OffscreenCanvas dispatcher and context loss](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/offscreencanvas/offscreen_canvas.cc)
- [CanvasResourceDispatcher](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/platform/graphics/canvas_resource_dispatcher.cc)

## Actual Preparation Evidence

Run from the project root:

```sh
node scripts/prepare-chromium-patches.ts
node scripts/verify-chromium-patches.ts
```

Both commands passed against the pinned official source. The receipt
`test-results/chromium-native-patches.json` records 15 source hashes, the
preparer hash, both patch hashes, their seven changed files and resulting
hashes. The independent `chromium-native-patches-evidence.json` retrieves
the official sources again and reconstructs the patched files in a fresh
temporary worktree; all files must match, including unchanged reference code
and LICENSE. It checks exact patch paths and explicit uncompiled / untested
status. Its temporary worktree was removed.

The initial malformed / insufficient-context patch attempt failed. Corrected
hunk counts and include context apply through ordinary `git apply --check`
without relaxed context flags. No installed Chromium binary, production
launch flags or package was changed. The TypeScript and application build
passed after adding the preparation and audit tools.

`passed=true` means source preparation / replay passed. The evidence retains
`nativeCompiled=false`, `runtimeVerified=false`, `capabilityPassed=false`.
No Claude login, account or paid model call was used.

The follow-up has separate receipts to preserve the original candidate and
the inputs of the running full-source preparation:

```sh
node scripts/prepare-chromium-callback-patch.ts
node scripts/verify-chromium-callback-patch.ts
```

`chromium-callback-patch.json` records the original receipt hash, both baseline
file hashes, patch scope and resulting hashes. The independent
`chromium-callback-patch-evidence.json` passed at 03:57:32 UTC after retrieving
five pinned official sources, replaying the original frame-sink patch, then
the callback follow-up, and comparing every resulting file. Its temporary
worktree was removed. `nativeCompiled`, `runtimeVerified` and
`capabilityPassed` remain false.

## Actual Compiler And Guest Execution

```sh
node scripts/verify-chromium-compiler.ts
node scripts/verify-chromium-compiler-guest.ts
```

The pinned official Mac ARM64 Clang package
`llvmorg-24-init-7747-g62397f8b-53` was downloaded, checked against its fixed
44,452,152-byte size and SHA256
`7ce015cde974fc32bb80e1f48aa7dddbdcbe44fd6f8614de5e63cae4733960d5`.
The matching upstream downloader revision and archive revision stamp were
checked. Clang 24 and LLD actually compiled and linked the freestanding
`native/chromium/compiler-probe.cc` with warnings treated as errors.
The resulting 1,376-byte executable has an ELF64 little-endian ARM64 header,
an executable file type and no dynamic-loader segment. Its SHA256 is
`2f602d034435743fcb3b99be77dba36283e2f4189db09bb9dbc0a6a8be410c64`.

`test-results/chromium-compiler.json` passed at 03:17:55 UTC. The first
version-check failure is retained as `chromium-compiler-before-version-check.json`:
the archive version was incorrectly assumed to equal Clang's executable Git
hash. The executable reports `86922d51225db089fffb99475eefc4904f79e3c8`;
archive hash and stamp checks remain strict. The pinned upstream
[compiler build script](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/tools/clang/scripts/build.py)
also applies changes after checking out the base revision, so the two kinds
of revision cannot be assumed identical.

The actual execution report `chromium-compiler-guest.json` passed from
03:19:33 to 03:20:53 UTC in a fresh strict, transparent-network Linux VM.
The unchanged executable's guest hash matched the host output, the actual
machine was `aarch64`, and the ordinary dev UID was 502. It printed exactly
`MuCodeSandbox ARM64 compiler probe` plus a newline, returned 0 and emitted
no stderr. Actual network protection before and after execution was active
with verified integrity. This test did not capture physical traffic or
exercise network faults and does not add a network-leak acceptance claim.
The temporary VM and its trusted base were deleted. Source copies and the
exact compiler receipt are retained under `test-results/chromium-compiler/`.
Extracted host compiler executables were also removed; only the checked
download cache remains under the ignored toolchain directory.

This proves basic Mac-to-Linux ARM64 code generation, linking and guest
execution. The program does not use Blink, Chromium, libc or the browser's
other dependencies. The reports explicitly keep `browserNativeCompiled=false`
and `fullBuildRouteVerified=false`; font and original-canvas recovery are
still unverified. It does not prove that the native patches compile.

## Full Source Preparation And Build Conditions

The host has 16 GiB RAM, about 208 GiB free disk at the basic compiler check,
and about 164 GiB after full preparation. Its selected developer tools are
`/Library/Developer/CommandLineTools`.

The pinned compiler downloader maps Linux to `Linux_x64`, including an ARM64
Linux host, while this product's guests are ARM64. Basic Mac cross-compilation
now passes; a complete Chromium build route is still unverified. Linux
sysroot, Rust, native host tools and full GN dependencies must also be checked.
The actual full pinned source checkout completed at 03:36:38 UTC. Official
dependency synchronization completed at 04:09:13 UTC, and hooks completed
at 04:12:18 UTC. GN then failed at `build/config/mac/mac_sdk.gni:113` because
`xcodebuild -version` requires full Xcode and the selected directory contains
only Command Line Tools. This is an actual configuration failure, not a
successful full build. `chromium-build.json`, timestamped receipts and raw
phase logs under `test-results/chromium-build/` retain the failure. The
original preparer is retained as
`2026-10-10T03-28-19-416Z-preparer.ts`; its hash matches the original receipt.

At 04:12:42 UTC, `apply-chromium-callback-patch.ts` passed against the actual
full checkout after the first preparation terminated. It checks the official
HEAD / origin, exact seven-file scope, original receipt and independently
replayed follow-up hashes, applies the two-file follow-up, verifies all seven
final hashes and checks reverse application without changing the files.
`chromium-full-source-patches.json` records the final source hashes. The
preparation script now recognizes both the original and follow-up states
for resumption. This revised preparer passed TypeScript checking; it has
not been rerun through the full synchronization pipeline. Native targets
and both new C++ regressions remain uncompiled.

Official Linux build instructions specify an x86-64 build host and at least 100 GB free disk:
[build requirements](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/docs/linux/build_instructions.md).
This is a compiler / SDK issue, independent of Apple developer signing.

## Actual Linux Compiler Fallback Check

`node scripts/verify-chromium-rosetta.ts` passed from 04:04:08 to 04:08:21 UTC.
It downloaded the pinned official Linux x64 Clang package, checked its
57,249,280-byte size and SHA256
`53c3bfd12b5d01378c6277bbebcacec595ef9d9fc4ec54f155c03a1b2cae4dbf`
against the pinned DEPS, and enabled guest Rosetta only in a fresh disposable
protected ARM64 VM with no user folder mounts. Actual binfmt registration
used `/mnt/lima-rosetta/rosetta`. Test-only signed Ubuntu amd64 runtime
libraries were installed in that VM; package output is retained.

The actual x64 ELF compiler ran through Rosetta as dev UID 502. Clang and LLD
24 reported revision `86922d51225db089fffb99475eefc4904f79e3c8`, compiled and
linked the original ARM64 freestanding probe, then ran that probe natively.
The probe printed the expected line, returned 0 and emitted no stderr. The
resulting ELF hash was
`ea7542c91a03efcbca5f0093cf1137888e7fddfc5e653c935b07379f5bcf92b3`.
`chromium-rosetta.json` records actual execution and verified network
protection before and after; the VM and its trusted base were deleted.
Verifier and probe source copies are retained under `chromium-rosetta/`.
There was no physical capture or fault test in this compiler prerequisite.

The exact pinned Linux ARM64 GN and Siso packages also exist in official
CIPD, verified by actual `describe` calls and saved as `gn-package.json`
and `siso-package.json`. They have not been executed in this fallback test.
This fallback check establishes actual compiler execution and basic ARM64
code generation without the Mac Xcode check. It does not establish full
Linux dependency synchronization, GN generation, Rust execution or Chromium
compilation. All browser and full-route acceptance fields remain false.

## Linux Full Build Pipeline

`scripts/build-chromium-linux.ts` now implements a separate persistent build
VM and three explicit stages:

```sh
node scripts/build-chromium-linux.ts --stage=prepare
node scripts/build-chromium-linux.ts --stage=tests
node scripts/build-chromium-linux.ts --stage=browser
```

The source copy completed at 04:27:21 UTC under
`native/chromium/build/linux/checkout/src`. It preserves the original checkout
and all seven final patched source hashes. The build VM shares only the
separate Linux build directory, runs development commands as dev, and uses
the existing strict transparent network. Rosetta is enabled only for build
tools in this VM; the browser target remains Linux ARM64. Rust host macros
are configured for the shipped x64 compiler. Full GN acceptance must still
establish that this configuration works.

Preparation installs the pinned upstream build dependencies, synchronizes
Linux dependencies and hooks, then invokes real GN. The test stage builds
`blink_platform_unittests` and runs `CanvasResourceDispatcherTest.*`; this
does not by itself compile the core font or OffscreenCanvas changes. The
browser stage builds `chrome`; original media and device-loss acceptance
remains separate. Each run saves the exact builder source, phase logs and
timestamped result under `test-results/chromium-linux/`. The stopped build
VM and source/output are retained for resumption.

Two actual preparation failures precede VM startup: the first cold source
scan exceeded its 30-second limit; a subsequent complete scan returned only
the expected seven files, and logged source scans now allow five minutes.
The second attempt failed schema validation because the shared-directory
configuration lacked its required UUID. The UUID was added without changing
the validation schema. Both failed receipts remain preserved. These are
preparation failures, not native compiler or runtime results.

The first real VM run started successfully with verified strict protection,
but the upstream dependency installer failed because the minimal image lacked
the `file` utility. The next resumed run encountered an ARM source advertising
amd64 indexes after boot; apt correctly rejected the missing indexes.
Preparation now installs `file` and `xauth`, and uses Deb822 to repair source
architecture constraints before the first apt update on a resumed VM.
These two failed runs also retain separate receipts and exact builder inputs.
The compiled-output checks require an executable ARM64 ELF with a saved
hash; the native test list must include all three added regression cases,
and the browser executable must report the pinned version. None of these
checks has passed yet.

The 04:40:45 UTC run completed upstream system-package installation at
04:42:30 UTC and verified dev UID 502, ARM64 and actual Rosetta registration.
Linux dependency synchronization then failed because `--revision src@...`
overrides the root's unmanaged setting and refuses its intended patches.
The pinned depot_tools implementation confirms this override behavior.
Both build preparation scripts now retain the already pinned unmanaged root
and synchronize its dependencies without that override. Exact HEAD and
source checks remain mandatory before and after synchronization. The revised
Mac preparation flow has not been rerun; its actual Xcode failure remains
the current Mac result. The Linux run's failed receipt, complete package log
and exact builder source are preserved separately.

The 04:49:14 UTC run revealed that an unmanaged root with an unversioned URL
still invokes `git remote set-head` and then a fallback remote HEAD query.
This run was intentionally cancelled through its authenticated guest task
supervisor after identifying that unnecessary lookup; exit 143 and verified
VM shutdown are preserved. It is an interrupted preparation, not a natural
network-failure test. The Linux configuration now pins the root URL itself
to the fixed commit while retaining unmanaged synchronization. Only the exact
known legacy configuration is migrated; other edits are rejected. Scope
checks now compare against HEAD, including staged changes, and the Linux
full-tree scan allows 15 minutes based on the observed multi-minute scan.

The 04:57:44 UTC run was subsequently interrupted after a verified shared
filesystem stall. The actual Git process had 20 metadata threads waiting in
`request_wait_answer`, while its main thread waited in `futex_wait_queue`;
CPU accounting had stopped advancing. An independent `stat` of the shared
LICENSE file also failed to return. Task cancellation was accepted, and the
dedicated VM was force-stopped at 05:13:29 UTC. The blocked stat exited 124
when the VM stopped. This is a manually interrupted preparation with a
filesystem diagnosis, not a successful dependency sync or browser fault test.

The builder now disables Git's parallel index preloading for guest commands,
without ignoring files or weakening HEAD / content checks. An additional
complete guest source-scope gate runs before synchronization. Cleanup always
closes the service; if ordinary stopping fails, a recorded force-stop fallback
applies only to this dedicated build VM. Force-stopped guests retain an open
boot-policy marker, so the next attempt correctly rejected configuration
changes with `GUARD_NOT_CONSERVATIVE`. The builder now recovers this through
the supported old-configuration start and ordinary stop before updating;
it does not bypass the guard check. The 05:17:39 UTC attempt actually recovered
closed boot policy, and the full single-threaded source-scope scan completed
at 05:22:46 UTC. Dependency synchronization then failed resolving the official
`infra/3pp/tools/gperf/linux-arm64` package at `version:3@3.2`, which does not
exist. The VM was stopped. Linux dependency sync, hooks, GN and native targets
had not passed in that run; the following host-tool work retains that failure.

## Linux Host-Tool Architecture

The builder now uses depot_tools' supported `.cipd_client_platform` override
to bootstrap the pinned `linux-amd64` client. The client is an actual x64 ELF,
executed as dev through guest Rosetta; its SHA256 is checked against the
unchanged pinned `cipd_client_version.digests`
(`11a383b48744870d96365192b92992650b695eedf3a745615948b8d6561834ed`).
The `.gclient` solution sets the supported custom `host_cpu` variable to x64,
matching GN's existing build-tool host choice; target OS / CPU remain Linux
/ ARM64. No Chromium source or runtime identity is changed by this selection.
The relevant pinned upstream implementations are
[client bootstrap](https://chromium.googlesource.com/chromium/tools/depot_tools/+/8a90b568605b8d70b2342cbedde4e15b3766b5bd/cipd)
and [custom variable precedence](https://chromium.googlesource.com/chromium/tools/depot_tools/+/8a90b568605b8d70b2342cbedde4e15b3766b5bd/gclient.py).

The 06:58:03 UTC run executed the correct client but failed because its first
platform-switch diagnostic was included in the text assertion. The builder
now reads the command's structured JSON result instead of treating diagnostic
text as a package name. That failed receipt and exact input remain retained.
The next run's actual JSON result is preserved as
`chromium-linux/2026-10-10T06-59-56-849Z-host-tool-platform.json`.
Linux dependency synchronization completed at 07:18:35 UTC; exact root HEAD
and all seven patched file content hashes passed. Full post-sync scope,
hooks, GN generation and native target results are separate subsequent gates.

`node scripts/verify-chromium-gperf.ts` actually passed from 07:23:48.010 to
07:23:56.415 UTC while the protected builder was running. It opens the state
database with SQLite readOnly, avoiding Store's restart mutation of live jobs.
The real `gperf` 3.2 binary is x64 ELF machine 62, SHA256
`9d523d970ae482b7e698b882a7a6f721b13fe782bf89fa82b8c075ab0f4d0aa8`.
It ran as dev UID 502, generated a two-keyword lookup implementation, and
native GCC compiled an ARM64 ELF machine 183. Actual alpha / beta positive
lookups and the gamma negative lookup all passed with no output or compiler
diagnostics. The ELF SHA256 is
`cf7685d17d17d4dd9b08b87dc6fb6d7011e8984fdff64eac77ac8f2c94e28bb2`.
Verifier source, generated C and actual ELF are retained in the timestamped
`test-results/chromium-gperf/` directory, with the canonical report
`chromium-gperf.json`. Network protection was active / integrity verified
before and after; this is not physical capture or Chromium compilation.

The dedicated builder also exposed a real shared-directory setuid privilege
escalation. Prioritize its isolation and safe migration before resuming builds;
see [shared directory verification](shared-mount-validation.md). No browser
native compilation or recovery capability follows from these diagnostics.

## Remaining Acceptance

Next acceptance must compile actual Blink / Chromium targets and run the
native regression, then the original six-stage font test and four-stage GPU
crash test against the resulting binary. The latter requires the same Worker
instances and original canvas pixels to recover, alongside actual protected
threads and physical network captures. Reopening the browser or replacing a
canvas is a different scope. Packaging, sandbox startup, complete media,
WebGPU feature / safety evaluation and long-running use remain required.

The original failed media and device-loss reports remain authoritative for
current installed capability. See [media](browser-media-validation.md) and
[actual device loss](browser-webgpu-device-loss-validation.md).
