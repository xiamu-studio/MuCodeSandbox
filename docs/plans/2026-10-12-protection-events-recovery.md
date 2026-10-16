# Protection events and recovery Implementation Plan

> **For execution:** Use the available executing-plans workflow task-by-task in the existing authorized project; preserve ongoing changes and verification evidence.

**Goal:** Every protective stop leaves a persistent, bounded, secret-free record and a visible repair path; retries only restore access after the original safety checks pass.

**Architecture:** Record per-receiver observations at detection, before stopping. Store events in local SQLite, resolve them only after successful guarded startup. Expose authenticated history and manual retry controls; never automatically approve a different exit IP or bypass TLS / firewall / lease checks.

**Tech Stack:** TypeScript, node:sqlite, Express, React, existing Lima lifecycle.

## Task 1: Receiver observations

Files: `shared/types.ts`, `server/egress.ts`, `tests/egress-quorum.test.ts`.
Preserve successful IPs, timeout / TLS / DNS / authentication / connection / invalid-response failures, and unfinished checks when an early mismatch cancels the remainder. Do not delay an immediate mismatch rejection for forensic completeness; do not label unfinished checks as successful or failed. Use only fixed receiver names and bounded categories, never authorization URLs or raw credentials.

## Task 2: Persistent protection events

Files: `shared/protection-events.ts`, `server/store.ts`, `server/manager.ts`, `tests/protection-events.test.ts`.
Capture event time, current environment ID, safe route snapshot, expected and observed IPs, receiver details, failure kind, stop result, repair steps, and later recovery proof. Keep at most100 per environment; deletion removes its events. A record write failure must never prevent the protected stop. Legacy errors may be shown as summaries with current configuration labelled accordingly, without fabricating old receiver evidence.

## Task 3: Guarded recovery and visible UI

Files: `server/service.ts`, `src/api.ts`, `src/ProtectionEvents.tsx`, `src/ProtectionBanner.tsx`, `src/App.tsx`, `src/panels.tsx`, `src/styles.css`.
Show unresolved failures above the functional tabs; log page keeps history and diagnostic download. Give reason-specific steps, network settings link, and explicit retry startup. An IP mismatch remains blocked unless the original route returns or the user deliberately changes the approved configuration. A failed retry adds / retains evidence rather than clearing the fault. Successful startup records the accepted receipts and time of recovery.

## Task 4: Verification and delivery

Tests: persistence after restart, recording before stop, secrets excluded, no auto IP approval, failed retry remains open, success resolves with proof, stopped history readable, authenticated actions, expired / changed configuration cannot inherit an old recovery. UI: reason, expected / actual IP, unfinished receipts, controls and download visible at normal and narrow sizes. Actual native app: show the existing failure honestly, retry via normal lifecycle, verify successful / failed outcome in saved records. No real accounts, changed real expected IP, large downloads, 24h tests, or signing prerequisites.

Save result and remaining network limitations in MD; update native application and verify build identity. Resume the concurrent-workspace login-opening gate after recovery, stopping before real-account input.
