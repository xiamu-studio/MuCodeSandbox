# Local Test Delivery Controls

The local test release needs editable controls for configuration already supported
by the backend. Keep the existing form layout and validation contracts.

- New Linux environments select integer disk capacity from 10 to 256 GiB;
  retain the 30 GiB default. Existing VM disks are not resized by this change.
- The DNS editor exposes address, TLS server name, port and HTTPS request path.
  Retain the existing defaults and backend certificate validation.
- Verify real UI creation, invalid capacity rejection, stored DNS settings,
  reopening the panel, preserving DNS while saving identity, and desktop/mobile
  layout using the existing UI acceptance script and a disposable data directory.

This change does not alter the browser engine, VM network policy or the frozen
b0cd06d application. Source UI acceptance is separate from packaged acceptance.
