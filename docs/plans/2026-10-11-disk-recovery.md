# Existing Full-Disk Recovery

Scope: grow an existing stopped Linux VZ environment without deleting user data.
Use official Lima, growpart and resize2fs. Do not change the browser, modify the
original user's VM for testing, or automatically clear files.

## Evidence Before Integration

- Old cf031a2 actually reaches dev ENOSPC with no ext4 reserved blocks.
- Its normal stop can fail writing network.nft.next; recovery must handle the
  actual stopped state after that failure.
- Official Lima edit changes the virtual disk capacity, but the old full root
  filesystem can still prevent cloud-init and automatic filesystem growth.
- Prototype: boot for management only, verify firewall and inactive business
  lease, keep growpart scratch files in /run tmpfs, expand the root filesystem,
  stop, then perform normal application startup.
- Prototype success must preserve the canary and allocated filler, accept a new
  fsynced write, reject bypass traffic and retain verifiable packet records.
  Capture after management SSH does not prove the maintenance boot's first packet.

## Product Implementation

1. Add a separate stopped-environment disk-growth job and UI command. Reject
   shrink, browser-only environments, missing disks, unknown/running state,
   unsupported disk layout, insufficient host space and concurrent operations.
   Keep initial imported-disk initialization restrictions.
2. Before changing configuration, publish a durable private maintenance journal.
   Include environment identity, original configurations and target capacity.
   Do not put temporary maintenance configuration into the normal saved settings.
3. Disable host project exports, forwarded application ports and provisioning in
   the temporary maintenance configuration. Revoke terminal, browser and bridge
   access. Never grant or renew the guest business network lease in maintenance.
4. Bound SSH readiness, filesystem operations and shutdown. Preserve the original
   configurations and journal on failure. An interrupted job must block ordinary
   start/configuration/snapshot access until a validated retry finishes.
5. Acknowledge the new capacity in SQLite only after filesystem verification and
   confirmed stop. Clear the journal after the saved settings are durable.
   Retry must cover a crash before/after either commit without shrinking a disk.
6. On application reopen, pending maintenance must revoke access and stop any
   leftover VM. Expose a clear retry state. Do not infer safety from a failed job
   flag alone or auto-start the environment after repair.

## Required Validation

- Actual UI growth of an old full disposable guest on the resulting package;
  file preservation, normal start, browser/CLI use and network enforcement.
- Rejection and concurrency tests; cancellation, actual process interruption,
  reopen, retry and no lingering maintenance VM/process/access.
- Snapshot and encrypted export/import after growth; restore an older smaller
  snapshot together with its disk/configuration, then grow again.
- Desktop and narrow-window screenshots; independent raw evidence review.
- Keep missing early maintenance-boot capture, host-full and physical power-loss
  validation explicit until separate evidence closes those gaps.

## Implementation Checkpoint

The product job, signed durable journal, startup/configuration/snapshot gates,
closed-lease maintenance, stripped host exports and retry UI are implemented.
Seven focused tests cover cancellation, reopen, unverified shutdown, tampering,
commit interruption and host-network change. All 145 source tests and TypeScript
checks pass. The e1caee5 candidate passes bundle integrity checks.

Actual old-full-guest UI growth to 12 GiB succeeded; the first resulting-package
run failed at a hidden-window screenshot timeout before normal-start validation.
That failure is retained as guest-disk-growth-product-before-visible-capture.json.
The next run shows the test window before capture and performs no manual growth
after the product job, so a helper cannot hide a product recovery defect.
The next resulting-package run passed at 19:29:13 UTC and independent review
passed at 19:29:37 UTC. Actual UI growth, fixture preservation, normal start and
protected networking passed, with three captures showing no unapproved egress.
Temporary resources were removed. The screenshots show the in-progress polling
state; completion is established by task/configuration/journal and normal boot.
Real hard interruption, maintenance first-packet capture and the full expanded
browser/CLI/backup workflow were separate validation work at that checkpoint.
The expanded-guest full workflow now passed at 19:42:59 UTC and independent
review at 19:43:30 UTC: actual UI growth, official browser/CLI, host file and
fixed-command grants, snapshot restore and encrypted import retaining 12 GiB,
four distinct normal boots and six raw captures with no unapproved egress.
Current-package shared UI checks also passed at 19:39:43 UTC, independent review
19:40:22 UTC. Both raw reviews were repeated at 19:48 UTC with separate stdout
packet decoding and identical counts. Actual hard interruption, maintenance
first-packet, older smaller snapshot restore and physical power loss remained
at that checkpoint. At 20:12 UTC the e1caee5 three-point real maintenance-worker
SIGKILL/UI retry/smaller snapshot workflow passed independent review of thirteen
captures. At 20:13 UTC its actual Electron SIGKILL after journal publication and
maintenance capture/guards before networkd passed six-capture review. An earlier
immediate-stop assertion failed; that failed report remains preserved.

The b3b92b6 candidate adds automatic reconciliation of idle pending-disk guests
to the background guard monitor, skipping active maintenance jobs. All 146 tests,
type checks, build and bundle integrity pass. At 20:23 UTC a real late Lima
startup replay after initial reconciliation was stopped by the actual Manager
timer without Electron/API/UI polling in 8067 ms, with zero lease renewals.
The same candidate's Electron kill, early maintenance guard/capture, closed
requests and UI retry passed six-capture review. No separate late-start-window
capture is claimed. Its expanded browser/CLI/backup workflow passed at 20:30:09
UTC and independent six-capture/four-normal-boot review at 20:30:53 UTC;
other candidate-specific regression, physical power loss, Mac switch/sleep and
full-day operation remain separate requirements.

Delivery scope is frozen to the local Apple Silicon Linux browser/Claude Code
test build. Do not add browser-kernel work, Claude Desktop or other platforms
while closing recovery and stability validation.
