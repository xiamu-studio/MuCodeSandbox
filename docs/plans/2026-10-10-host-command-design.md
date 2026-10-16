# Restricted Host Commands

Extend the existing short-lived directory capability. A grant separately lists
approved command IDs; file read/write permission alone never enables commands.
The initial catalog is Git status, working-tree diff and the last 20 commits.
Each command has immutable host-side arguments. Requests cannot supply an
executable, shell text, environment, working directory or extra arguments.

The native helper retains its open directory descriptor. Before execution it
resolves that descriptor, checks the repository directory and rejects hard-linked
regular files in a bounded walk. Git runs from the retained directory using a
minimal environment, no global/system configuration, optional locks, hooks,
filesystem monitor, pager, external diff or text conversion. User repository
configuration is still untrusted; the OS boundary must hold independently.

Use the existing macOS sandbox-exec facility with a deny-default profile: allow
read-only access to the approved project and system runtime, no network, no
project writes and execution of the selected system Git binary only. Its
descendants inherit the profile. Missing tools or sandbox support fail closed.
This is a local managed-command boundary, not a Network Extension or protection
for every Mac process. Do not use it to claim that native Chrome now works.

One command may run per grant, with an 8-second deadline and a 64 KiB combined
output limit. A helper and its children share a dedicated process group.
Revocation, expiration, environment quarantine/stop, output overflow or timeout
terminate that group; no background task may outlive the capability. Audit
command IDs and outcomes, never command output or file contents. Existing
bearer scope, loopback/origin checks and VM SSH Unix-socket transport remain.

Acceptance requires real Git operations, denied extra arguments/unapproved IDs,
hostile local Git configuration, outside reads/writes, protected versus
unprotected IPv4/IPv6 network controls, root replacement, output overflow,
timeout/revocation and descendant cleanup. Then verify actual VM client transport
and the authorization UI. Broader build/test commands require their own catalog
entries and acceptance; arbitrary host shell execution is not a deliverable.
