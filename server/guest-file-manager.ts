// Install only the lightweight file manager and its X11 D-Bus activation helper.
// Existing browser/desktop processes already run as dev behind the VM guard.
export const ENSURE_FILE_MANAGER = `set -eu
if ! command -v thunar >/dev/null || ! command -v dbus-launch >/dev/null; then
  sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y -qq --no-install-recommends --no-remove -o APT::Sandbox::User=dev thunar dbus-x11
fi
command -v thunar >/dev/null
command -v dbus-launch >/dev/null
# Ubuntu's Thunar service advertises the Xfce name; Chrome requests the standard name.
sudo install -d -o root -g root -m 0755 /usr/local/share/dbus-1/services
file_manager_service=$(sudo mktemp /usr/local/share/dbus-1/services/.mu-file-manager-XXXXXXXX)
sudo tee "$file_manager_service" >/dev/null <<'MU_FILE_MANAGER_BUS'
[D-BUS Service]
Name=org.freedesktop.FileManager1
Exec=/usr/bin/Thunar --gapplication-service
MU_FILE_MANAGER_BUS
sudo chown root:root "$file_manager_service"
sudo chmod 0644 "$file_manager_service"
sudo mv -f "$file_manager_service" /usr/local/share/dbus-1/services/org.freedesktop.FileManager1.service
`;
