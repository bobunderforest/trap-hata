# Trap Hata

A local multiplayer canvas game. The game runs in a browser tab on a big
screen; players join by scanning its QR code with their phones, which become
gamepads.

## How it works

- **Game tab (`/`)** runs the whole simulation and rendering, and shows a QR
  code linking to `/pad#<room>`.
- **Pad (`/pad`)** connects to that game tab **peer-to-peer over WebRTC**
  data channels. On the same Wi-Fi this stays on the local network, so input
  latency is a few milliseconds.
  - `input` channel: unordered, no retransmits — joystick positions.
  - `ctrl` channel: reliable — button presses, join/death events.
- **Signalling Worker (`/signal/:room`)** — a tiny Cloudflare Worker with one
  Durable Object per room. It only relays the WebRTC handshake (offer, answer,
  ICE candidates) between the game tab and pads; no gameplay traffic goes
  through it. Everything else is static files.

## Develop

```sh
npm install
npm run dev
```

Vite serves the game and runs the signalling Worker locally (via
`@cloudflare/vite-plugin`), so no Cloudflare account or deploy is needed.
It listens on your LAN, and when you open the game on `localhost` the QR code
automatically points at your machine's LAN IP so phones on the same Wi-Fi can
join. Allow Node through the firewall on private networks if Windows asks.

## Deploy to Cloudflare

```sh
npx wrangler login
npm run deploy
```

This builds `dist/` and deploys static assets + the signalling Worker. It fits
in the Workers Free plan: static asset requests are free, and each phone
joining costs roughly one Worker request plus a handful of WebSocket messages.

## Limitations

- Phones and the game screen must be able to reach each other directly. Guest
  or office Wi-Fi with client isolation will block this; supporting those
  networks would need a TURN relay (e.g. Cloudflare Realtime TURN).
- The world size is the game tab's window size.
- At most `MAX_ACTIVE_ROOMS` games can be hosted at once and `MAX_NEW_ROOMS_PER_DAY`
  new games created per UTC day, and each IP address (IPv6: each /64 network) gets
  at most `MAX_ACTIVE_ROOMS_PER_IP` and `MAX_NEW_ROOMS_PER_IP_PER_DAY` of those
  (see `vars` in `wrangler.jsonc`). Over a limit,
  the game screen shows "Too many games right now" and retries every minute.

## Scripts

| Script            | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | Dev server (game + pad + Worker), on the LAN   |
| `npm run build`   | Build static site and Worker into `dist/`      |
| `npm run preview` | Build, then serve the production build locally |
| `npm run deploy`  | Build and deploy to Cloudflare                 |
| `npm run lint`    | ESLint                                         |

## Credits

This small game was made for a hackathon back in 2016 by two friends,
[Dmitrii Ivakhnenko](https://github.com/jeetiss) and
[Dmitrii Podlesnyi](https://bobunderforest.me/).

You can check its source code on the
[Github repository](https://github.com/bobunderforest/trap-hata).

## Security

**Signalling Worker** (`worker/index.js`)

- Only `/signal/<room>` reaches the Worker. Room codes and pad ids must match strict patterns.
- WebSocket upgrades only, same `Origin` only.
- Rate limit: 60 connections/min per IPv4 address or IPv6 /64 (`SIGNAL_RATE_LIMIT`).
- Room ownership: random host key sent as a WebSocket subprotocol, only its SHA-256 hash stored. Wrong key: close 4003. Same key again: old connection replaced (4000). New-room claim is race-free.
- Room limits (`vars` in `wrangler.jsonc`): active games and new games per UTC day, globally and per IP. Over limit: close 4029. Missing or invalid vars fall back to defaults, never to "unlimited".
- Pads: join only rooms with a live host. Max 16 signalling at once per room, 30 s and 50 messages each.
- Host: max 300 messages/min.
- Messages over 16 KB or not JSON: dropped. Over a limit: disconnected (1008).
- Messages stay inside one room: pads reach only their host, host reaches pads by id.
- Cleanup: room data deleted 1 h after host leaves. Registry drops active rooms after 12 h, even if a close event was lost.
- Client IPs stored only as salted SHA-256 hashes. Salt never leaves registry storage.
- WebSocket hibernation: idle connections cost nothing.

**Static site** (`public/_headers`)

- Strict CSP: scripts, styles, fonts, connections from own origin only. No inline scripts, no plugins.
- No embedding in other sites (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). Embedding would bypass the `Origin` check.
- `nosniff`, `strict-origin-when-cross-origin` referrer, `same-origin` opener policy. `Permissions-Policy` disables camera, microphone, geolocation, payment, USB.
- No third-party requests. Font self-hosted. Only external service: Cloudflare STUN.

**Peer-to-peer**

- After the handshake, gameplay goes browser to browser over encrypted WebRTC data channels (DTLS). None of it passes through Cloudflare.
- Room codes (10 chars) and host keys (40 chars) from `crypto.getRandomValues`. Not guessable.
