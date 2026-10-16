> Cancelled before deployment: user requested keeping the current fonts and avoiding repeated configuration changes. All code changes in this plan were withdrawn. No font or XSETTINGS changes were applied to the VM.

# Linux desktop text rendering polish implementation plan

Goal: improve text consistency in the existing streamed Linux desktop without changing virtualization identity, networking, accounts or data isolation.

Architecture: share one XSETTINGS recipe between display startup and later DPI updates. Add a fixed, root-owned fontconfig fragment for outline fonts only; grayscale antialiasing avoids assuming the final Mac screen subpixel order. Keep bitmap-only emoji and missing-glyph fonts available. No new packages, user profile rewrite or hardware claims.

Alternatives considered: full desktop/GPU replacement is too disruptive for this maintenance scope; changing names or API returns would not improve actual hardware. Use small real rendering changes instead.

1. Add `server/guest-appearance.ts`: shared validated XSETTINGS text and fontconfig fragment with a bounded, symlink-safe idempotent installation script. Only application-owned fragment is writable by this recipe; do not modify existing user configs.
2. Use shared XSETTINGS content from `guest-display-runtime.ts` startup and `guest-display.ts` DPI updates; preserve process ownership/cgroup validation. Install the fragment when ensuring display components, without restarting services.
3. Verify XML/fontconfig semantics against actual installed guest fonts in an isolated FONTCONFIG_FILE, including Chinese bold/monospace and emoji preservation. Test generated script safety and settings consistency across scale changes.
4. Apply the exact fragment and a validated hot DPI update to current display. Check current-boot protection hashes, approval, profiles and two independent exit IP observations before/after. Use synthetic/local content only, never provider pages or online translation.
5. Build/check candidate and deliver through normal app update if safe for current drafts; preserve original app for rollback. Confirm runtime version, profile identity and strict guard again. Document actual visual and deployment limits.
