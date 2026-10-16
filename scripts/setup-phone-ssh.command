#!/bin/zsh
set -eu

relay_dir=/Users/staff/.mucodesandbox/remote/dedione-lax-166-88-36-199
script_dir="${0:A:h}"
node_bin=/Users/staff/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node

if ! /usr/bin/ssh -F none -S "$relay_dir/admin.sock" -O check root@166.88.36.199 >/dev/null 2>&1; then
  "$relay_dir/connect-admin.command"
fi
"$node_bin" "$script_dir/setup-phone-ssh.mjs"
read 'phone_ack?Press Return to close this window.'
