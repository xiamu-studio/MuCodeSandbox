# Explicit Mac image clipboard to Linux

User wants to avoid saving a clipboard image as a Mac file, then manually uploading it. Add a click-triggered image transfer to the existing shared quick tools. Do not make a permanent incoming file or automatically send a website attachment.

Desktop bridge: read only an image from the Mac clipboard after a trusted local main-frame user gesture. NativeImage normalizes to PNG in memory, with byte/pixel limits. A local browser fallback can use the explicit Clipboard API/paste gesture. No polling, text/HTML fallback, file URLs, Mac path access, image logging or preview persistence.

Service: authenticated PNG binary endpoint uses the existing GuestExchange per-environment lock and before/after authorization. Validate PNG signature, bounded chunks/CRC, dimensions and bounded inflate before any guest change. Fixed guest program and bytes travel only on stdin; never argv. Use a private systemd socket-activated image clipboard owner under dev, bound to the display service. The accepted socket delivers a length-prefixed PNG to a Python owner which pipes it to xclip and acknowledges verified ownership; retain bytes in RAM only. No PNG image files on either host. Text clipboard writes stop the image owner/socket; a new image stops the prior owner. Display stop kills the owner and removes the socket.

UI: a prominent “粘贴图片到沙箱” action within file tools; explicit paste events in the panel can do the same. Transfer doesn't press Ctrl+V/Enter or submit to websites. Close/switch/disconnect before capture completes prevents transmission; stale delivery results do not announce success. Graphical targets tell users to return to their intended app and Ctrl+V. Terminal entry keeps the action but explains that image paste depends on CLI support, with no raw binary sent to the PTY.

Verify with synthetic NativeImage/clipboard stubs, adversarial PNG inputs, API/auth tests and owned UI fixtures. Use a separate test X display for actual xclip roundtrip so user clipboard is not touched. Keep existing text/file/translation/tab/guard checks. No real AI pages or model requests. Package before asking to restart saved work.
