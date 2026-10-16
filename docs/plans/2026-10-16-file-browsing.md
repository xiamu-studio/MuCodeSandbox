# File folders, dates and desktop reveal

User problem: the flat transfer list mixes uploads/downloads/exports, hides modification time and does not show folders. Chrome's “Show in folder” does nothing. Improve the current Linux workflow without changing its network protection or adding automatic Mac filesystem access.

Chosen scope:
- Add Thunar and dbus-x11 from the existing signed Ubuntu apt repositories with no recommends/removals or system upgrade. Register the standard org.freedesktop.FileManager1 activation name, which the installed Xfce service does not advertise as a separate activation entry. Launch Chromium within dbus-run-session under the existing dev systemd unit and display lifetime. Keep sandbox, graphics, language, timezone and network flags intact.
- Browse Downloads, Transfers/Outgoing and Transfers/Incoming separately, one folder level at a time, with breadcrumb navigation, directories first, file mtime ordering and explicit refresh. Keep opening the tool immediate and non-scanning.
- Show modification time in Mac local time and last listing time. “New/updated in this refresh” requires a prior observation; never claim an mtime is an export receipt.
- Traverse nested directories by anchored descriptors, reject symlinks/mount changes/non-owned folders/path traversal, and retain normal-file/hardlink/size checks. A bounded metadata revision identifies a listed file; compare before/after download to reject a stale or changing file, with a refresh instruction.
- Keep the old flat-list endpoint behavior for compatibility, add validated directory query fields, and extend the existing download request with parent path/revision. No background transfer or broad filesystem API.

Tests: actual production Python in synthetic directory trees (including nested links, hardlinks, FIFO, traversal, tied timestamps, paging and changed files); production UI fixtures for scoped navigation, time labels, explicit new/updated labels, download revision, small windows, and existing file/input/terminal regressions; related guard, task, lease and quorum checks. Verify package before restarting production. Real Chrome folder reveal needs the refreshed browser session; do not mark it passed from installation or D-Bus introspection alone.
