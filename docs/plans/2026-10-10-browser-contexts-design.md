# Browser Context Consistency

Extend real Linux browser acceptance beyond a page, dedicated Worker and same-origin
frame. Use two disposable protected VMs with different language / timezone settings,
the production browser launcher and unchanged Chromium sandbox / network rules.

The fixture runs as dev on guest loopback only. `127.0.0.1` and `localhost` provide
two distinct sites and standards-defined secure contexts for real ServiceWorker
registration. A TLS fixture would additionally test certificate handling but require
a separate test trust store; treating insecure origins as secure with a browser flag
would alter the product security configuration. This acceptance therefore uses real
loopback secure contexts and does not claim public HTTPS validation.

Measure page, dedicated / shared / service workers, same-site and cross-site frames,
and a user-initiated new window. Compare common identity properties, actual request
headers, font widths and available Canvas / GPU results. Report unavailable APIs
separately. Confirm actual cross-site iframe targets, actual shared-worker identity,
ServiceWorker activation, host font inventory and fonts used by Chromium.

Use the same origin and fixture port in both VMs. A synthetic ServiceWorker cache
marker must survive browser close and VM restart, while the other VM starts clean
and retains only its own marker. Record protection fingerprints and an actual
physical-interface capture with approved proxy traffic as a positive control.

No account, paid model, host network changes, certificate bypass, disabled renderer
sandbox, or device impersonation. Retain failed evidence and repair product behavior
only if real measurements identify a defect. Snapshot and distribution acceptance
remain independent.

## Downloaded Fonts And Offline Audio

Run `test:browser-media` in separate report / artifact paths so the earlier context
acceptance remains preserved. Repeat all seven contexts and the six fresh / reopen /
VM restart stages with the unchanged production browser and renderer sandbox.

Serve an installed, licensed Liberation Sans TTF through the guest loopback fixture
with no cache and a deliberate one-second delay. Each measurement uses a new family
name, observes unloaded / loading / loaded states, compares fallback and downloaded
font metrics / pixels, and rejects a genuine 404 font. Confirm the page's actual
custom font through Chromium CSS diagnostics. Compare results across contexts and
restarts; record the source TTF hash. This is a real font download and font engine
test, not public CDN / TLS validation.

Use OfflineAudioContext at a fixed sample rate with a real oscillator / compressor.
Require finite nonzero samples, identical repeated rendering, a different result
after changing frequency, and matching page / frame / popup output after restart.
Workers must report their actual API boundary; absence is not audio success.

Record WebGL context-creation diagnostics, Chromium GPU feature status, and actual
pixels if WebGL works. Unavailable rendering remains unverified. Do not enable the
unsafe SwiftShader fallback or disable Chromium's sandbox to obtain a green result.

Keep the complete acceptance gate separate from completed observations. A known
late-registration mismatch, unavailable WebGL, or unverified GPU-process sandbox
must keep `browser-media-acceptance.json` failed and the command nonzero. Reproducing
the font behavior in ordinary Mac Chrome is diagnostic evidence, not a fix. Record
renderer and GPU-process kernel status separately while the browser is still open.

## Graphics Sandbox Follow-Up

The initial actual GPU process had seccomp=0. Backend experiments did not produce
verified sandboxed WebGL; early sandbox alone initially crashed the graphics
process. Production now explicitly uses protected 2D mode and checks only its own
service cgroup before website navigation. Both renderer and GPU process must have
seccomp, no-new-privileges, no capabilities and protected sibling threads; the
renderer additionally needs a separate PID namespace. Failed inspection stops the
service and deletes the display secret.

Fresh A/B six-stage regression verified 28 renderers / 370 threads and six GPU
processes / 66 threads, no GPU crashes, normal profile exit and approved-only
physical output. Actual source and compiled-package faults disable the GPU
sandbox, confirm seccomp=0, require startup rejection before navigation, then
restore normal operation. Keep full 3D acceptance false: Canvas2D success does
not replace shader / triangle / movement tests or fix late Worker font caching.
