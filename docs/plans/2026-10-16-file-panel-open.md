# File panel opening responsiveness

Confirmed problem: opening the file tool automatically starts a guarded scan and wraps it in a global transfer busy flag. Tabs and close/return become unavailable even though no file is being uploaded.

Chosen scope: frontend only. Opening the panel does not request the file listing; upload/path/text tools become available immediately. Existing files are loaded explicitly. Separate list state from mutation state, permit tab switches/close during reads, suppress late results after close/disconnect/environment change, and keep network transfer buttons disabled while an actual server-side list is in flight to respect the existing one-operation-per-environment boundary. A closed read is ignored, not falsely claimed cancelled at the server.

Keep manual listing, pagination, failed-list status, upload atomicity, sizes, symlink checks, before/after authorization and fail-closed logic unchanged. Do not cache an old result as fresh or remove security work to improve a timing number.

Verification: local component fixture compares previous/current opening with the same controlled slow listing; assert no scan on open, immediate upload/return, explicit reading label, switch/close during read, stale results/errors ignored, no duplicate reads, and guarded mutations serialized. Existing file/input/translation tools regressions and package checks. Read-only production timings expose only counts/timing, not filenames/content. No real AI services or model calls.
