# Official Browser Upgrade and Recovery

The user authorized implementation with official browser binaries, no engine
fork, no real Claude account and no paid model calls. Existing Linux VM, profile,
renderer sandbox and network boundaries remain the architecture.

## Delivery Requirements

1. Only accept an application-approved official version and pinned SHA-256.
2. Prepare and validate a root-owned candidate before changing an existing
   installation. Corrupt downloads and extraction failure retain the old binary.
3. Record a durable transaction before switching directories. Process interruption
   must recover deterministically on the next browser operation. A committed
   installation must not be rolled back by incomplete cleanup.
4. Preserve browser profile data. Before a different browser version opens a
   profile, checkpoint it so failed adoption can restore compatible data.
5. Validate candidate startup, real renderer / GPU sandbox, identity, network
   integrity and basic rendering before adoption. Failed adoption closes access
   and restores the prior approved version and its compatible profile.
6. Expose installed / approved version, explicit update / recovery commands and
   operation progress through the existing authenticated API and UI. Integrate
   operation locking and monitoring; no arbitrary URL or digest from a guest.
7. Verify two distinct official versions, synthetic Cookie / localStorage / IDB,
   bad checksum, unpack failure, actual process kills, restart recovery, packet
   captures and the delivered Electron package. Retain exact evidence and cleanup.

## Approach

Use application-approved version metadata and side-by-side staging. This fits the
existing pinned installer and lets each adopted version receive the same sandbox
and network acceptance. OS package upgrades remain useful for dependencies but do
not provide the profile checkpoint or product acceptance transaction. Downloading
and immediately selecting the latest online build would skip these acceptance
requirements, so discovery must be separate from adoption.

The first implementation step replaces the current destructive directory update
with a recoverable binary installation transaction. It covers download, unpack,
validation and interruption recovery, while preserving the current executable
path and approved version. It does not by itself deliver version discovery,
cross-version profile rollback, automatic adoption or the UI updater. These remain
requirements above, not redefined as complete by a successful repair test.

## Binary Transaction

Prepare the candidate under a root-controlled sibling directory. Validate the
official archive again inside the VM, its version, executable and setuid sandbox
helper permissions. Save prior recipe and AppArmor policy in a root-owned journal,
then durably rename the old directory to backup and candidate to its final path.
Install the matching AppArmor policy and recipe, durably mark committed, then
remove backup and journal. Existing user profile data is never modified by this
binary installation step.

Recovery runs before checking the installed recipe. Pending transactions restore
the backup and prior policy / recipe; committed transactions finish cleanup.
Recovery stops an orphan browser service before replacing files. Reject ambiguous
or malformed journals without deleting arbitrary paths. Cancellation must not
prevent a bounded recovery attempt, and a failed recovery remains visible rather
than being reported as success. Use root-controlled locks against concurrent
installers. Disk-full and true power-loss durability require separate validation.
