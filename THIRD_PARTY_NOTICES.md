# Third-Party Components

MuCodeSandbox uses independently published components. It does not include code
extracted from Code Sandbox and is not affiliated with the referenced product.
Upstream license files and notices must be retained when packaging dependencies.

## sing-box

The transparent Linux feature downloads the unmodified ARM64 release of sing-box
1.14.3 from the upstream project and verifies a pinned SHA-256 before installation.
The desktop application does not bundle this executable. Its archive and upstream
LICENSE remain in the local runtime cache; LICENSE is also installed at
`/usr/local/share/doc/mu-sing-box/LICENSE` inside the guest.

- Project and corresponding source: <https://github.com/SagerNet/sing-box/tree/v1.14.3>
- License: GNU GPL version 3 or later, including the upstream naming restriction.
- License source: <https://github.com/SagerNet/sing-box/blob/v1.14.3/LICENSE>
- Copyright: 2022 nekohasekai.

## noVNC

The local `scripts/retained-frame-updates.ts` bundling patch adds an
`updatesPaused` property to pinned RFB 1.7.0. It suspends framebuffer requests
and continuous updates for hidden viewers while retaining the socket and decoder.
The transformation source is included in this repository under the same MPL-2.0
terms for this modification. Upstream copyright/license notices are retained.

The guest browser viewer uses `@novnc/novnc` 1.7.0 to implement the RFB client.
MuCodeSandbox adds a native Uint8Array Base64 fast path during bundling, with the
existing encoder retained for compatibility. A local RFB update extension pauses
hidden viewers and repaints/requests a full frame when a visible viewer needs
refreshing, while retaining its decoder and authenticated connection. Image bytes and the RFB protocol
are unchanged. The application transports the stream through authenticated local
WebSocket and SSH connections.

- Project and corresponding source: <https://github.com/novnc/noVNC/tree/v1.7.0>
- Primary license: Mozilla Public License 2.0 (MPL-2.0).
- The installed package retains `LICENSE.txt`, `AUTHORS` and `docs/LICENSE*`,
  including notices for vendored components with their own licenses.
- Source files covered by MPL remain available in the upstream source above and
  the installed package. The corresponding modified `core/base64.js` and
  `core/rfb.js` sources are included in `desktop/third-party-source/novnc-1.7.0/core/` inside the
  installed application's `Contents/Resources/app` directory, under MPL-2.0.

## TurboVNC Server

The Linux display downloads the unmodified official TurboVNC 3.3.1 ARM64 DEB
through the guest network. It verifies the archive SHA-256
`ad2448cd80997174c47b507e058fc385716aa9bd71c04e149f8da5a98fa77a9b`
and independently verifies the extracted Xvnc executable before use. Only the
server executable and its license notice are extracted; DEB maintainer scripts,
vendor services, the Java viewer and its JRE are not installed.

- Project and corresponding official source release:
  <https://github.com/TurboVNC/turbovnc/releases/tag/3.3.1>
- Server source includes GPL-2.0-or-later code and separately licensed components.
  The upstream license notice is installed in the guest at
  `/opt/mucodesandbox/turbovnc-3.3.1/LICENSE.txt`; the original DEB remains in
  `/var/cache/mucodesandbox-display/`.
- The ARM64 executable is not bundled into the macOS application.

## Playwright

`playwright-core` 1.64.0 supplies official Chromium download metadata and browser
automation used by verification. `@playwright/test` is a development dependency.

- Project: <https://github.com/microsoft/playwright>
- License: Apache License 2.0.
- Installed packages retain their upstream `LICENSE`, `NOTICE` and
  `ThirdPartyNotices.txt` where supplied. These notices also cover dependencies
  bundled by Playwright; they do not replace the downloaded browser's licenses.

## Linux Chrome for Testing / Chromium

The guest browser downloads the unmodified official Linux ARM64 Chrome for Testing
156.0.8078.4 artifact referenced by Playwright's Chromium revision 1248:

- Artifact: <https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-linux-arm64.zip>
- Pinned SHA-256: `910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce`.
- Download metadata: the installed `playwright-core` registry and `browsers.json`.
- Chrome for Testing project: <https://github.com/GoogleChromeLabs/chrome-for-testing>
- Chromium license: <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>.
- Chromium third-party notices are available through the browser's `chrome://credits`.

The initial digest was measured from the fixed official HTTPS artifact and is
pinned in source. Subsequent downloads and the root-owned guest copy are checked
against it. This is a pinned-content check, not a separate upstream signature.

The browser executable is not included in the desktop application. The complete
downloaded archive is retained under the local runtime tools cache. Extracted
upstream files, including `ABOUT` and the supplied Widevine license, remain in the
root-owned `/opt/mucodesandbox/chromium-156.0.8078.4/chrome-linux-arm64` directory.
Chrome for Testing includes components with separate terms; the Chromium license
alone must not be described as the license for every file in that archive.

## Other Dependencies

Portable encrypted backups use unmodified tar-stream 3.2.2 (MIT,
<https://github.com/mafintosh/tar-stream>) for standard streaming tar parsing and
generation. The package and its dependencies retain their upstream license files.
Compression, scrypt and AES-256-GCM use the Node.js runtime APIs.

The account-free lab uses dns2 3.1.1 (MIT,
<https://github.com/lsongdev/node-dns>) and stun 2.1.0 (MIT,
<https://github.com/nodertc/stun>). Original licenses remain in the installed
packages. Both provide local test protocol endpoints.

Lima, Electron and its bundled Chromium, node-pty, React, xterm.js, and other
dependencies retain their upstream licenses and notices. JavaScript dependencies
are installed through the package manager. Lima is downloaded from its official
release and checked against a pinned checksum. Ubuntu guest packages such as
Xvfb, x11vnc, xauth and fonts are installed from the guest's configured package
repositories; their licenses remain under `/usr/share/doc` and the package data.

The name MuCodeSandbox does not imply endorsement by any upstream project.
