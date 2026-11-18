import { networkInterfaces } from 'node:os';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|tailscale|zerotier|vpn|loopback/i;
const PRIVATE_RANGES_BY_PREFERENCE = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./];

function findLanAddress() {
  const candidates = Object.entries(networkInterfaces())
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .flatMap(([, addresses]) => addresses)
    .filter(({ family, internal }) => family === 'IPv4' && !internal)
    .map(({ address }) => address);

  for (const range of PRIVATE_RANGES_BY_PREFERENCE) {
    const match = candidates.find(address => range.test(address));
    if (match) return match;
  }
  return null;
}

export default defineConfig(({ command }) => {
  const isLocal = command === 'serve';
  const lanAddress = isLocal ? findLanAddress() : null;

  return {
    plugins: [cloudflare()],
    define: isLocal ? { 'import.meta.env.DEV_LAN_ADDRESS': JSON.stringify(lanAddress) } : {},
    server: { host: true },
    preview: { host: true },
    css: { transformer: 'lightningcss' },
    environments: {
      client: {
        build: {
          rollupOptions: {
            input: {
              index: 'index.html',
              pad: 'pad.html'
            }
          }
        }
      }
    }
  };
});
