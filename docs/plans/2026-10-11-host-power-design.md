# Host Sleep Protection

The desktop currently monitors protected guests periodically but does not react
to Electron host suspend/resume notifications. Connect both events to Manager.

On either event, synchronously invalidate access and quarantine all active strict
Linux guests, abort outstanding jobs and revoke terminals/viewers/host grants via
the existing quarantine path. Attempt lease revocation and guest shutdown through
the existing runtime stop path. Resume does not automatically restart a guest.

Keep protected starts/access blocked while host suspension or event shutdown is
pending. Recheck the barrier after asynchronous snapshot recovery and before
business lease activation. Generation and cancellation checks prevent pending
access checks or startup tasks from renewing a revoked lease.

Unprotected environments and native browser sessions keep their existing scope.
Use focused Manager tests for overlapping events, pending access and starts,
missing suspend notification, and guest stop failure. Actual Electron event
injection and real VM shutdown still require package acceptance; event injection
does not prove real Mac sleep/wake timing. No claim that asynchronous handlers
finish before macOS sleeps or before a waking guest can emit its first packet.
