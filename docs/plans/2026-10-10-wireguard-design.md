# Packet Tunnel Development

The default product remains the protected Linux browser and Claude Code VM.
This work adds an IPv4 kernel WireGuard path; it must not silently wrap the
existing connection proxy and claim that original guest TCP is preserved.

## Required Behavior

- Use the Linux kernel's WireGuard interface, with no userspace TCP termination
  between the guest and the controlled receiving router.
- Accept structured single-peer configuration, canonical 32-byte keys, explicit
  unicast endpoint IPv4 / port, one tunnel IPv4 /32, fixed default AllowedIPs,
  a bounded MTU and a fixed packet mark. Reject arbitrary config directives,
  shell hooks, unsupported IPv6 and split routes.
- Encrypt private key storage and omit keys from API responses, arguments and
  logs. Install guest secrets in root-only files, with atomic replacement.
- Keep the conservative first-boot firewall and empty short-lived permission.
  Only the approved marked UDP transport may leave the physical interface;
  no general UDP or root network exception is sufficient.
- Route development traffic through the WireGuard interface. Keep DNS controlled;
  block other unsupported UDP and IPv6. Preserve management and expiring-lease
  behavior without turning either into a business bypass.
- Activate business access only after config / route / DNS / actual peer health
  and approved final exit validation. Interface presence is insufficient.
- Inspect approved kernel peer, endpoint, mark, routes, file ownership, boot
  dependencies and DNS. Ignore only changing timestamps / counters. Host-owned
  expected state remains the authority.
- Peer failure, bad credentials, route changes, management failure and restart
  must preserve default refusal and recovery through normal lifecycle actions.

## Development Stages

Current evidence: stages 1 and 2 passed their explicit kernel and two-VM
lifecycle tests. Stage 3 passed configuration UI, first boot capture, cold
browser installation, persistent identity/data, actual account-free Claude tools,
native PTY interruption, and the actual packaged browser/tool workflow. Additional
real two-VM faults passed: networkd restart / same-address DHCP renewal, invalid
system DNS quarantine, immediate kernel revocation on lease-directory ENOSPC
with the host timer paused, and sustained peer outage with automatic quarantine
and normal recovery. The latest package rerun used CLI 2.1.296. Full TUI,
broader tools, packaged fault/snapshot/bridge cases and stage 4 remain unverified.
See `wireguard-validation.md` for
report timestamps, failures, capture scope and unsupported configurations.

1. Structured configuration and actual kernel primitive verification. A disposable
   protected VM hosts isolated client, gateway and receiver namespaces. Compare
   raw TCP SYN before encryption and after decryption / routed NAT, allowing only
   required source / checksum and TTL changes. Include a working direct-route
   positive control, approved encrypted UDP capture, route-bypass, wrong-peer,
   tunnel-down and recovery tests. This stage is not a production network mode.
2. Integrate root-only storage, protected base provisioning, normal runtime
   lifecycle, host integrity inspection, short-lived permission and controlled
   DNS. Run real two-VM tests across the actual VM physical interfaces.
3. Expose validated configuration and honest state in the existing UI; verify
   browser and Claude fixture traffic, persistent data and package behavior.
4. Verify an explicitly authorized real endpoint with a public receiver and
   actual exit policy. Residential lines are user-provided and require a peer
   offering packet transport; HTTP(S) / SOCKS credentials are insufficient.

Packet preservation does not make Linux a Mac, repair a downstream TCP proxy,
establish eligibility to use a service, or guarantee account outcomes. Browser
identity consistency, packet integrity, absence of bypass and final public exit
are separate acceptance requirements.
