#!/bin/bash
# Runs after the .deb is removed: the command link and the AppArmor profile from after-install.sh.

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'projectdockhub' '/usr/bin/projectdockhub'
else
    rm -f '/usr/bin/projectdockhub'
fi

if [ -e /etc/apparmor.d/projectdockhub ]; then
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove /etc/apparmor.d/projectdockhub 2>/dev/null || true
    fi
    rm -f /etc/apparmor.d/projectdockhub
fi
