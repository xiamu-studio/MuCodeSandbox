import { CONFIGURE_GUEST_HOSTNAME_SCRIPT } from './guest-hostname.ts';
import { CONFIGURE_NETWORKD_SCRIPT } from './guest-networkd.ts';
import { CONFIGURE_GUEST_STORAGE_SCRIPT } from './guest-storage.ts';

export const CONTROL_UID = process.getuid?.() === 2000 ? 2001 : 2000;
export const DEVELOPMENT_UID = process.getuid?.() ?? 1000;
export const DEVELOPMENT_PACKAGES = ['git', 'curl', 'ca-certificates', 'xz-utils', 'python3', 'build-essential', 'ripgrep', 'jq', 'nodejs'] as const;
export const PREPARE_DEVELOPER_SCRIPT = `set -euo pipefail
${CONFIGURE_GUEST_STORAGE_SCRIPT}
${CONFIGURE_GUEST_HOSTNAME_SCRIPT}
${CONFIGURE_NETWORKD_SCRIPT}
if ! id dev >/dev/null 2>&1; then
  if getent passwd ${DEVELOPMENT_UID} >/dev/null; then
    sudo useradd --create-home --shell /bin/bash dev
  else
    sudo useradd --create-home --uid ${DEVELOPMENT_UID} --shell /bin/bash dev
  fi
fi
sudo usermod -G '' dev
sudo chmod 0700 /home/mu /home/dev
sudo install -d -m 0755 /usr/local/libexec
sudo install -d -o dev -g dev -m 0755 /workspace
if [ -L /home/dev/.local ]; then echo 'Development tools directory must not be a symlink' >&2; exit 1; fi
sudo mkdir -p /home/dev/.local
sudo chown --no-dereference dev:dev /home/dev/.local
sudo -H -u dev mkdir -p /home/dev/.local/bin
sudo tee /usr/local/libexec/mu-install-packages >/dev/null <<'MU_INSTALL'
#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root LANG=C LC_ALL=C
cd /
if [ "$#" -lt 1 ] || [ "$#" -gt 8 ]; then exit 64; fi
for package in "$@"; do
  case "$package" in ${DEVELOPMENT_PACKAGES.join('|')}) ;; *) echo 'Package not approved' >&2; exit 64 ;; esac
done
if [ -f /etc/mucodesandbox/environment ]; then
  set -a
  . /etc/mucodesandbox/environment
  set +a
fi
/usr/bin/apt-get update -qq
exec /usr/bin/apt-get install -y --no-install-recommends "$@"
MU_INSTALL
sudo chmod 0755 /usr/local/libexec/mu-install-packages
sudo tee /usr/local/bin/mu-install >/dev/null <<'MU_CLIENT'
#!/bin/bash
exec /usr/bin/sudo -n /usr/local/libexec/mu-install-packages "$@"
MU_CLIENT
sudo chmod 0755 /usr/local/bin/mu-install
printf 'dev ALL=(root) NOPASSWD:NOSETENV: /usr/local/libexec/mu-install-packages\\n' | sudo tee /etc/sudoers.d/mucodesandbox-dev >/dev/null
sudo chmod 0440 /etc/sudoers.d/mucodesandbox-dev
sudo visudo --check --file /etc/sudoers.d/mucodesandbox-dev
echo 'Development tasks use dev; unrestricted sudo is not granted'
`;
