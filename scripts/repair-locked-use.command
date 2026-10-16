#!/bin/zsh
set -eu

installer_app='/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app'
installer_bin="$installer_app/Contents/MacOS/Codex Computer Use Installer"
installed_info='/Library/Security/SecurityAgentPlugins/CodexComputerUseAuthorizationPlugin.bundle/Contents/Info.plist'
source_info="$installer_app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle/Contents/Info.plist"

if [[ ! -x "$installer_bin" ]]; then
  print -u2 'The bundled OpenAI installer was not found. No changes were made.'
  exit 1
fi

/usr/bin/codesign --verify --deep --strict "$installer_app"
signature=$(/usr/bin/codesign -dv --verbose=4 "$installer_app" 2>&1)
if ! print -r -- "$signature" | /usr/bin/grep -Fqx 'TeamIdentifier=2DC432GLL2'; then
  print -u2 'The installer does not have the expected OpenAI signing identity. Stopping.'
  exit 1
fi

print 'Using the signed installer bundled with ChatGPT.'
print 'Complete any macOS administrator authentication yourself on this Mac.'
"$installer_bin" status
"$installer_bin" install

print 'Installed authorization plug-in version:'
/usr/bin/plutil -extract CFBundleShortVersionString raw "$installed_info"
print 'Bundled authorization plug-in version:'
/usr/bin/plutil -extract CFBundleShortVersionString raw "$source_info"
print 'Installer status:'
"$installer_bin" status
print 'Installation alone does not confirm locked Computer Use works.'
print 'Restart ChatGPT normally, then test a read-only task from a connected device after locking this Mac.'
print 'Avoid physical keyboard or pointer input during that test.'
read 'repair_ack?Press Return to close this window.'
