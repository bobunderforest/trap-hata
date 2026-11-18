import { DurableObject } from 'cloudflare:workers';

const ROOM_PATH = /^\/signal\/([a-z0-9]{6,32})$/;
const PEER_ID = /^[a-z0-9]{8,64}$/;
const HOST_KEY_PROTOCOL = /^host-key\.([a-z0-9]{32,64})$/;
const HOST_PROTOCOL = 'trap-hata-host';
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_CONNECTING_PADS_PER_ROOM = 16;
const ROOM_EXPIRY_AFTER_HOST_LEAVES_MS = 60 * 60 * 1000;
const CLOSE_CODE_REPLACED_BY_ANOTHER_HOST = 4000;
const CLOSE_CODE_ROOM_OWNED_BY_ANOTHER_HOST = 4003;
const CLOSE_CODE_TOO_MANY_ROOMS = 4029;
const CLOSE_CODE_POLICY_VIOLATION = 1008;
const CLOSE_CODE_NORMAL = 1000;
const CLOSE_CODES_THAT_CANNOT_BE_SENT = new Set([1005, 1006, 1015]);
const PAD_SIGNALLING_LIFETIME_MS = 30 * 1000;
const MAX_MESSAGES_PER_PAD = 50;
const HOST_MESSAGE_WINDOW_MS = 60 * 1000;
const MAX_HOST_MESSAGES_PER_WINDOW = 300;
const ACTIVE_ROOM_ACCOUNTING_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ROOM_LIMITS = {
  MAX_ACTIVE_ROOMS: 20,
  MAX_NEW_ROOMS_PER_DAY: 200,
  MAX_ACTIVE_ROOMS_PER_IP: 10,
  MAX_NEW_ROOMS_PER_IP_PER_DAY: 50
};

export default {
  async fetch(request, env) {
    const match = new URL(request.url).pathname.match(ROOM_PATH);
    if (!match) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (!isSameOrigin(request)) {
      return new Response('Forbidden origin', { status: 403 });
    }
    if (!(await isWithinRateLimit(request, env))) {
      return new Response('Too many requests', { status: 429 });
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return room.fetch(request);
  }
};

function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get('Host');
  } catch {
    return false;
  }
}

async function isWithinRateLimit(request, env) {
  if (!env.SIGNAL_RATE_LIMIT) return true;
  const { success } = await env.SIGNAL_RATE_LIMIT.limit({ key: clientNetwork(request) });
  return success;
}

const IPV6_GROUPS = 8;
const IPV6_GROUPS_IN_SUBNET_PREFIX = 4;

function clientNetwork(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);
  return `${ipv6SubnetPrefix(ip)}::/64`;
}

function ipv6SubnetPrefix(ip) {
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const omittedGroups = new Array(IPV6_GROUPS - headGroups.length - tailGroups.length).fill('0');
  return [...headGroups, ...omittedGroups, ...tailGroups]
    .slice(0, IPV6_GROUPS_IN_SUBNET_PREFIX)
    .map(group => parseInt(group, 16).toString(16))
    .join(':');
}

function requestedProtocols(request) {
  return (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map(protocol => protocol.trim())
    .filter(Boolean);
}

function hostKeyFrom(request) {
  for (const protocol of requestedProtocols(request)) {
    const match = protocol.match(HOST_KEY_PROTOCOL);
    if (match) return match[1];
  }
  return null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function parseSignal(message) {
  if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

export class Room extends DurableObject {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const role = params.get('role');

    if (role === 'host') {
      return this.connectHost(request);
    }
    if (role === 'pad') {
      return this.connectPad(params.get('id'));
    }
    return new Response('Bad role', { status: 400 });
  }

  async connectHost(request) {
    const hostKey = hostKeyFrom(request);
    if (!hostKey) {
      return new Response('Missing host key', { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const response = new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': HOST_PROTOCOL }
    });

    const presentedHash = await sha256Hex(hostKey);
    const ownerHash = await this.ctx.storage.get('hostKeyHash');
    const isNewRoom = ownerHash === undefined;

    if (!isNewRoom && ownerHash !== presentedHash) {
      return rejectHost(server, response, CLOSE_CODE_ROOM_OWNED_BY_ANOTHER_HOST, 'Room belongs to another host');
    }
    if (isNewRoom) {
      this.ctx.storage.put('hostKeyHash', presentedHash);
    }
    if (!(await this.registry().acquire(this.roomId(), isNewRoom, clientNetwork(request)))) {
      if (isNewRoom) {
        await this.ctx.storage.delete('hostKeyHash');
      }
      return rejectHost(server, response, CLOSE_CODE_TOO_MANY_ROOMS, 'Too many games right now');
    }

    this.disconnectPreviousHost();
    this.ctx.acceptWebSocket(server, ['host']);
    server.serializeAttachment({ role: 'host', windowStart: Date.now(), messagesInWindow: 0 });
    await this.ctx.storage.deleteAlarm();
    return response;
  }

  registry() {
    return this.env.ROOM_REGISTRY.get(this.env.ROOM_REGISTRY.idFromName('global'));
  }

  roomId() {
    return this.ctx.id.toString();
  }

  connectPad(id) {
    if (!PEER_ID.test(id ?? '')) {
      return new Response('Bad pad id', { status: 400 });
    }
    if (!this.hasHost()) {
      return new Response('No game in this room', { status: 404 });
    }
    this.closeExpiredPads();
    if (this.openSockets('pad').length >= MAX_CONNECTING_PADS_PER_ROOM) {
      return new Response('Room is busy', { status: 429 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['pad', `pad:${id}`]);
    server.serializeAttachment({ role: 'pad', id, connectedAt: Date.now(), messageCount: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  openSockets(tag) {
    return this.ctx.getWebSockets(tag).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  hasHost() {
    return this.openSockets('host').length > 0;
  }

  disconnectPreviousHost() {
    for (const previous of this.ctx.getWebSockets('host')) {
      previous.close(CLOSE_CODE_REPLACED_BY_ANOTHER_HOST, 'Replaced by a new host');
    }
  }

  closeExpiredPads() {
    const now = Date.now();
    for (const ws of this.openSockets('pad')) {
      if (now - ws.deserializeAttachment().connectedAt > PAD_SIGNALLING_LIFETIME_MS) {
        ws.close(CLOSE_CODE_POLICY_VIOLATION, 'Signalling took too long');
      }
    }
  }

  chargeMessage(ws) {
    const sender = ws.deserializeAttachment();

    if (sender.role === 'pad') {
      sender.messageCount += 1;
      if (sender.messageCount > MAX_MESSAGES_PER_PAD) {
        ws.close(CLOSE_CODE_POLICY_VIOLATION, 'Too many signalling messages');
        return null;
      }
    } else {
      const now = Date.now();
      if (now - sender.windowStart >= HOST_MESSAGE_WINDOW_MS) {
        sender.windowStart = now;
        sender.messagesInWindow = 0;
      }
      sender.messagesInWindow += 1;
      if (sender.messagesInWindow > MAX_HOST_MESSAGES_PER_WINDOW) {
        ws.close(CLOSE_CODE_POLICY_VIOLATION, 'Too many signalling messages');
        return null;
      }
    }

    ws.serializeAttachment(sender);
    return sender;
  }

  webSocketMessage(ws, message) {
    const sender = this.chargeMessage(ws);
    if (!sender) return;

    const msg = parseSignal(message);
    if (!msg) return;

    if (sender.role === 'pad') {
      this.relay('host', { from: sender.id, data: msg.data });
    } else if (typeof msg.to === 'string') {
      this.relay(`pad:${msg.to}`, { data: msg.data });
    }
  }

  relay(tag, payload) {
    const out = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(tag)) {
      ws.send(out);
    }
  }

  async webSocketClose(ws, code) {
    await this.releaseRoomIfHostLeft(ws);
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.close(CLOSE_CODES_THAT_CANNOT_BE_SENT.has(code) ? CLOSE_CODE_NORMAL : code, 'Closed');
    }
  }

  async webSocketError(ws) {
    await this.releaseRoomIfHostLeft(ws);
  }

  async releaseRoomIfHostLeft(ws) {
    if (ws.deserializeAttachment()?.role === 'host' && !this.hasHost()) {
      await this.registry().release(this.roomId());
      await this.ctx.storage.setAlarm(Date.now() + ROOM_EXPIRY_AFTER_HOST_LEAVES_MS);
    }
  }

  async alarm() {
    if (!this.hasHost()) {
      await this.registry().release(this.roomId());
      await this.ctx.storage.deleteAll();
    }
  }
}

function rejectHost(server, response, code, reason) {
  server.accept();
  server.close(code, reason);
  return response;
}

const CLIENT_HASH_SALT_BYTES = 32;

function randomHex(byteCount) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class RoomRegistry extends DurableObject {
  async acquire(roomId, isNewRoom, network) {
    const client = await this.anonymize(network);
    const now = Date.now();
    const activeRooms = await this.activeRooms(now);

    if (activeRooms[roomId] === undefined) {
      if (!this.hasFreeActiveSlot(activeRooms, client)) {
        return false;
      }
      if (isNewRoom && !(await this.countNewRoomToday(now, client))) {
        return false;
      }
    }

    activeRooms[roomId] = { since: now, client: activeRooms[roomId]?.client ?? client };
    await this.ctx.storage.put('activeRooms', activeRooms);
    return true;
  }

  async anonymize(network) {
    let salt = await this.ctx.storage.get('clientHashSalt');
    if (salt === undefined) {
      salt = randomHex(CLIENT_HASH_SALT_BYTES);
      this.ctx.storage.put('clientHashSalt', salt);
    }
    return sha256Hex(`${salt}:${network}`);
  }

  hasFreeActiveSlot(activeRooms, client) {
    const rooms = Object.values(activeRooms);
    const roomsOfClient = rooms.filter(room => room.client === client);
    return rooms.length < this.limit('MAX_ACTIVE_ROOMS')
      && roomsOfClient.length < this.limit('MAX_ACTIVE_ROOMS_PER_IP');
  }

  limit(name) {
    const configured = Number.parseInt(this.env[name], 10);
    return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_ROOM_LIMITS[name];
  }

  async release(roomId) {
    const activeRooms = await this.activeRooms(Date.now());
    delete activeRooms[roomId];
    await this.ctx.storage.put('activeRooms', activeRooms);
  }

  async activeRooms(now) {
    const stored = (await this.ctx.storage.get('activeRooms')) ?? {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, room]) => now - room.since < ACTIVE_ROOM_ACCOUNTING_TTL_MS)
    );
  }

  async countNewRoomToday(now, client) {
    const today = utcDay(now);
    const stored = await this.ctx.storage.get('newRoomsToday');
    const usage = stored?.day === today ? stored : { day: today, count: 0, countByClient: {} };
    const countOfClient = usage.countByClient[client] ?? 0;

    if (usage.count >= this.limit('MAX_NEW_ROOMS_PER_DAY')
      || countOfClient >= this.limit('MAX_NEW_ROOMS_PER_IP_PER_DAY')) {
      return false;
    }
    usage.count += 1;
    usage.countByClient[client] = countOfClient + 1;
    await this.ctx.storage.put('newRoomsToday', usage);
    return true;
  }
}
