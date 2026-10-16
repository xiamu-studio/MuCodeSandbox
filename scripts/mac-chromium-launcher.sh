#!/bin/sh
set -eu
: "${MU_MAC_CHROMIUM_EXECUTABLE:?Missing Chromium executable}"
: "${MU_MAC_CHROMIUM_POLICY:?Missing network policy}"
exec /usr/bin/sandbox-exec -p "$MU_MAC_CHROMIUM_POLICY" "$MU_MAC_CHROMIUM_EXECUTABLE" "$@"
