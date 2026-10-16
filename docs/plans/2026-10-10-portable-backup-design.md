# Portable Environment Backups

Export one authenticated offline snapshot as a password-encrypted `.mu-backup`
file. Whole-data-directory copies would couple recovery to local service keys and
all environments. Plain archives would expose browser sessions and proxy secrets.
Use per-environment encrypted archives, with a fresh identity on import.

- Stream standard tar through gzip and AES-256-GCM. Derive the key with scrypt
  using a random salt; authenticate the versioned envelope as associated data.
  Passwords stay in memory and never enter jobs, logs or command arguments.
- Use the maintained tar-stream parser. Accept only one bounded JSON manifest,
  one raw disk and optional guard metadata. Reject links, paths, duplicates,
  extra entries, inconsistent sizes and content hashes. Extract into a private
  staging directory; publish nothing until the complete authentication tag passes.
- Preserve sparse disks while extracting. Check available capacity before export
  and during materialization; report ENOSPC as failure and keep existing data.
  Export publishes exclusively and never overwrites an existing backup.
- Import validates configuration and creates a new environment ID. Remove host
  mounts and forwarded ports; retain guest language, timezone and selected network
  settings. Do not import Lima YAML, host management keys, VM hardware identifiers
  or bridge credentials. Encrypted credentials are re-encrypted with the new store.
- Stage an authenticated local seed image without booting it. Normal lifecycle
  creates the VM from this image using fresh Lima management keys and hardware
  identity. A strict seed must have a conservative, armed current guard. Verify
  seed identity and SHA256 before boot, then apply normal network/lease checks.
- Cloud-init can retain the old host public key in the guest disk. Before opening
  an imported environment, replace mu's authorized keys with the current key and
  clear root's inherited management authorization. Reconnect to verify the new
  key, then durably mark initialization ready. Interrupted initialization must not
  reconcile as running. Repeat key replacement on later normal startups. Check
  root-owned paths with privileged operations. Guest OS/application identifiers
  remain disk data; only the specified management and VZ identities are fresh.
- UI provides password confirmation, native path selection when available,
  background jobs and cancellation. Import is available without an existing VM.

Verify wrong passwords, tampering, truncation, hostile tar members, cancellation,
existing-file protection, sparse materialization and distinct store keys. Real VM
acceptance exports and imports across independent data directories, checks guest
data, regenerated management access, fresh identity, no inherited host shares,
strict first-boot traffic and normal lifecycle. Actual second-Mac and whole-device
power failure remain separate acceptance; same-host independent stores are not
described as cross-machine proof. No Claude account or paid model is used.

Browser migration acceptance uses a local synthetic login issued as a persistent
HttpOnly cookie, plus actual localStorage and IndexedDB writes. Verify the source
starts empty, closes normally, and the restored browser can authenticate without
another login before and after VM restart. Then exercise the generated app's
export/import dialogs, real archive jobs, imported VM startup, nonblank remote
browser canvas and approved-only physical traffic. Source and packaged execution
must have separate reports and captures. This does not test a real service account
or a second Mac, and manual path entry does not validate a native file dialog.
