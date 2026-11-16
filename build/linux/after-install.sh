#!/bin/bash
# Runs after the .deb is installed. Same as electron-builder's default script, plus an AppArmor profile:
# Ubuntu 23.10+ blocks unprivileged user namespaces, so Electron's sandbox cannot start when the app is opened
# from the app menu or dock and the app crashes at once. The profile allows them for this one program only
# (Ubuntu ships the same kind of profile for Discord, Chrome, VS Code...).

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/projectdockhub' -a -e '/usr/bin/projectdockhub' -a "`readlink '/usr/bin/projectdockhub'`" != '/etc/alternatives/projectdockhub' ]; then
        rm -f '/usr/bin/projectdockhub'
    fi
    update-alternatives --install '/usr/bin/projectdockhub' 'projectdockhub' '/opt/ProjectDockHub/projectdockhub' 100 || ln -sf '/opt/ProjectDockHub/projectdockhub' '/usr/bin/projectdockhub'
else
    ln -sf '/opt/ProjectDockHub/projectdockhub' '/usr/bin/projectdockhub'
fi

if [ -d /etc/apparmor.d ] && hash apparmor_parser 2>/dev/null && [ -e /etc/apparmor.d/abi/4.0 ]; then
    cat > /etc/apparmor.d/projectdockhub <<'PROFILE'
# Written by the ProjectDockHub package. It allows everything and only lets Electron's sandbox use user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile projectdockhub /opt/ProjectDockHub/projectdockhub flags=(unconfined) {
  userns,

  include if exists <local/projectdockhub>
}
PROFILE
    apparmor_parser --replace --write-cache /etc/apparmor.d/projectdockhub || true
    chmod 0755 '/opt/ProjectDockHub/chrome-sandbox' || true
elif ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # No AppArmor and no user namespaces: use the SUID sandbox helper.
    chmod 4755 '/opt/ProjectDockHub/chrome-sandbox' || true
else
    chmod 0755 '/opt/ProjectDockHub/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
