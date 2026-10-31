// Keep packaging and build identity on the same Windows runtime input list.
export const WINDOWS_RUNTIME_SCRIPTS = [
 'hyperv.ps1','host-components.ps1','seed-iso.ps1','build-channel.ps1','build-broker.ps1',
 'install-broker.ps1','clean-runtime-metadata.ps1','snapshot-owner-files.ps1','backup-cleanup.ps1','backup-output.ps1',
] as const;
export const WINDOWS_RUNTIME_SOURCES = [
 'HyperVBroker.cs','SealedBases.cs','HostComponents.cs','ProtectedLedger.cs','RestoreOriginProof.cs',
 'OriginPreparation.cs','RestoreOriginStore.cs','RestoreOriginFrames.cs','ImageCache.cs','ResourceMetrics.cs',
 'Resources.cs','DiskGrowth.cs','BackupRead.cs','BackupRestore.cs','RestoreOriginOperations.cs',
 'RestoreOriginInitialization.cs','RestoreOriginSnapshots.cs','OfflineSnapshots.cs','SnapshotStaging.cs',
 'SnapshotOperations.cs','BackupCursor.cs','Recovery.cs','RecoveryPermissions.cs','PowerWatch.cs',
 'PowerProtection.cs','HyperVChannel.cs','RuntimeMetadataCleanup.cs','SnapshotOwnerFiles.cs','BackupCleanup.cs','BackupOutput.cs',
] as const;
