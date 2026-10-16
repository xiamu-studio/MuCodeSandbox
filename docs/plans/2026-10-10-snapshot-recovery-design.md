# Snapshot Recovery Durability

The current snapshot restore stages replacement files and rollback copies, then
writes a journal before replacing the VM disk and configuration. Add explicit
durability barriers and rollback content validation before building export/import
on top of this transaction.

1. Sync copied files and their containing directories. Sync the prepared journal
   and transaction directory before changing any installed VM file.
2. Record rollback size and SHA256 in a version 2 authenticated journal. Verify all
   rollback copies and configuration before recovery changes any target. Keep
   version 1 journals readable for existing interrupted restores, while recording
   that they predate rollback checksums.
3. Sync each installed target directory after rename. Persist SQLite configuration
   before publishing the committed journal. Recovery of an uncommitted transaction
   returns to the complete pre-restore state; committed transactions keep the
   restored state and only remove transaction data.
4. Reject a corrupted rollback without overwriting current files or deleting the
   journal. A failed recovery remains visible and prevents lifecycle startup.
5. Kill a dedicated restoration process after the disk replacement in a disposable
   real VM. Reopen the manager and use the normal start lifecycle to recover; check
   the guest disk marker, host shared project, configuration and transaction cleanup.
   Add a committed-journal interruption control and repeat recovery after interruption.
6. Publish each prepared or committed journal by writing and syncing a separate file,
   then renaming and syncing its directory. Mark completed rollback committed before
   deleting any recovery copy, so cleanup can safely resume after interruption.
7. Reserve the environment synchronously before lifecycle recovery yields; block
   concurrent configuration and lifecycle changes and wait for recovery on shutdown.
   Re-read configuration after recovery before creating or restoring another snapshot.
8. Kill after SQLite configuration save but before transaction commit. Normal startup
   must recover both the pre-restore disk and configuration, including when the next
   requested operation is snapshot creation or another cancelled restore.

Automated tests use small files to cover corrupt rollback and repeatability. The
real VM acceptance uses normal Lima lifecycle and SIGKILL; it does not cut Mac power
or claim to prove hardware power-loss durability. Filesystem sync cannot replace
testing the storage device's behavior. No Claude account or paid model is used.

Validation: 78 automated tests passed. The final real VM run passed from
2026-10-09T20:48:52.706Z to 2026-10-09T20:52:02.272Z, including five interruption
windows, corrupt snapshot refusal, shared-project preservation and owned VM cleanup.
See `../snapshot-recovery-validation.md` for source hashes and packaging scope.

Backup export/import, capacity admission and cross-machine migration remain separate
deliverables. Exported archives must protect credentials and browser data, and import
must revalidate local paths, VM identities and networking rather than trust old host
configuration. They are not considered implemented by this recovery change.
