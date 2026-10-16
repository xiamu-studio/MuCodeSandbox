# Guest network lease

## Requirement

Strict Linux environments must stop business traffic when the host manager
dies or stalls. Approval must expire inside the guest without a guest daemon
refreshing itself. First boot and subsequent boot must start with no business
permission. Expired sessions must require a fresh start and verification.

## Design

Use a second nftables table with input/output hooks and an initially empty
timed IPv4 set. The kernel checks the set on every business packet, including
existing connections. The host renews a 45-second permission only after guard
and optional final-exit verification. A root-only helper serializes activation,
renewal and revocation, binding them to a random host start session and guest
boot ID. Expired or revoked sessions cannot renew or activate again.

Pinned sing-box 1.14.3 uses its included gVisor TCP/IP stack explicitly. The
default system stack rewrote probe SYNs into a distinct internal connection,
losing the original conntrack mark and blocking pre-activation replies. Packet
capture demonstrated this failure. gVisor avoids that internal kernel TCP
translation; this choice requires fresh TCP, DNS and browser regression tests.
The probe uses the configured DoH service with its IP pinned and verified TLS,
so it does not require opening the shared system resolver before activation.

Management SSH, DHCP and loopback remain narrow exceptions. A dedicated
unprivileged probe account can measure through TUN before business approval;
its connections and the tunnel's outer proxy connection use distinct conntrack
marks for return traffic. Business users cannot assume either identity. The
existing default-deny table still constrains all external destinations.

Boot service dependencies require the empty lease table before networking.
Host fingerprints cover rules, boot files, helper and dependencies; timed set
contents are excluded only from structural hashes and checked separately.
Graceful close revokes permissions; a hard kill is handled by kernel expiry.

Alternative guest watchdog processes have a failure mode when the watchdog
dies. Host-only timers cannot enforce a decision after the host process dies.
Kernel expiry avoids both dependencies while preserving the existing data path.

## Acceptance

Use disposable real VMs and a local authenticated proxy, with continuous
bidirectional traffic as a positive control. Kill the actual manager process,
verify VM remains alive while existing and new business requests stop, verify
management remains usable, and reject delayed renewal / activation. Verify
restart starts closed, approval opens traffic, graceful close revokes promptly,
and unprivileged users cannot refresh permission or alter policy. Preserve
packet capture and reports; use no Claude account or paid model.

Sleep/wake clock behavior, live public routing, hostile root and unrelated Mac
programs remain separate requirements. Kernel expiry does not itself prove
fixed public sources, and no timing claim extends beyond actual experiments.
