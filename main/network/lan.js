'use strict';

const os = require('os');

// Network adapters that only exist inside this computer (Docker, WSL, VPN, virtual machines).
// Another computer on the Wi-Fi cannot reach them.
const VIRTUAL_NAME = /(vethernet|wsl|docker|virtualbox|vmware|vbox|hyper-v|loopback|tailscale|zerotier|vpn|tun|tap|br-)/i;

// 192.168.x.x, 10.x.x.x and 172.16-31.x.x: the ranges a home or office router hands out.
function isPrivateIPv4(address) {
  const p = String(address).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

// The addresses other computers on the same network can use to reach this one, best guess first.
// `interfaces` is only a parameter so a test can pass its own list.
function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const item of list || []) {
      const v4 = item.family === 'IPv4' || item.family === 4;
      if (v4 && !item.internal && isPrivateIPv4(item.address)) found.push({ name, address: item.address });
    }
  }
  const rank = (a) => (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b));
}

module.exports = { lanAddresses, isPrivateIPv4 };
