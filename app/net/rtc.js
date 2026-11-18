const STUN_FALLBACK_FOR_UNRESOLVABLE_LAN_ADDRESSES = { urls: 'stun:stun.cloudflare.com:3478' };
const RTC_CONFIG = { iceServers: [STUN_FALLBACK_FOR_UNRESOLVABLE_LAN_ADDRESSES] };

const LOSSY_CHANNEL = { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 };
const RELIABLE_CHANNEL = { negotiated: true, id: 1 };

const CLOSE_CODE_REPLACED_BY_ANOTHER_HOST = 4000;
const CLOSE_CODE_ROOM_OWNED_BY_ANOTHER_HOST = 4003;
const CLOSE_CODE_TOO_MANY_ROOMS = 4029;
const RETRY_WHEN_TOO_MANY_ROOMS_MS = 60000;
const HOST_PROTOCOL = 'trap-hata-host';
const PAD_JOIN_TIMEOUT_MS = 20000;
const MAX_RECONNECT_DELAY_MS = 15000;

export function randomId(length = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function signallingUrl(room, params) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/signal/${room}?${new URLSearchParams(params)}`;
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const lossy = pc.createDataChannel('lossy', LOSSY_CHANNEL);
  const reliable = pc.createDataChannel('reliable', RELIABLE_CHANNEL);
  return { pc, lossy, reliable };
}

function sendJson(channel, msg) {
  if (channel.readyState === 'open') {
    channel.send(JSON.stringify(msg));
  }
}

function isGone(pc) {
  return pc.connectionState === 'failed' || pc.connectionState === 'closed';
}

function createSequentialQueue() {
  let tail = Promise.resolve();
  return step => {
    tail = tail.then(step).catch(logSignallingError);
    return tail;
  };
}

function logSignallingError(err) {
  console.warn('[signalling]', err);
}

export function hostRoom({ room, hostKey }, { onJoin, onStatus, onRoomTaken }) {
  const peers = new Map();
  let ws;
  let reconnectAttempt = 0;

  function connectToSignalling() {
    onStatus('connecting');
    ws = new WebSocket(signallingUrl(room, { role: 'host' }), [HOST_PROTOCOL, `host-key.${hostKey}`]);
    ws.onopen = () => {
      reconnectAttempt = 0;
      onStatus('ready');
    };
    ws.onmessage = ({ data }) => handleSignal(JSON.parse(data));
    ws.onclose = ({ code }) => {
      if (code === CLOSE_CODE_TOO_MANY_ROOMS) {
        onStatus('busy');
        setTimeout(connectToSignalling, RETRY_WHEN_TOO_MANY_ROOMS_MS);
        return;
      }
      onStatus('offline');
      if (code === CLOSE_CODE_ROOM_OWNED_BY_ANOTHER_HOST) {
        onRoomTaken();
      } else if (code !== CLOSE_CODE_REPLACED_BY_ANOTHER_HOST) {
        const delay = Math.min(1000 * 2 ** reconnectAttempt++, MAX_RECONNECT_DELAY_MS);
        setTimeout(connectToSignalling, delay);
      }
    };
  }

  function sendSignal(to, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ to, data }));
    }
  }

  function handleSignal({ from, data }) {
    if (typeof from !== 'string' || !data) return;

    let peer = peers.get(from);
    if (!peer) {
      if (!data.sdp) return;
      peer = acceptPad(from);
    }

    peer.enqueue(async () => {
      if (data.sdp) {
        await peer.pc.setRemoteDescription(data.sdp);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sendSignal(from, { sdp: peer.pc.localDescription });
      } else if (data.candidate) {
        await peer.pc.addIceCandidate(data.candidate);
      }
    });
  }

  function acceptPad(id) {
    const { pc, lossy, reliable } = createPeerConnection();
    const peer = {
      id,
      pc,
      enqueue: createSequentialQueue(),
      onMessage: null,
      onLeave: null,
      sendReliable: msg => sendJson(reliable, msg),
    };
    peers.set(id, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(id, { candidate });
    };

    const receive = ({ data }) => peer.onMessage?.(JSON.parse(data));
    lossy.onmessage = receive;
    reliable.onmessage = receive;

    let joined = false;
    reliable.onopen = () => {
      joined = true;
      onJoin(peer);
    };

    const leave = () => {
      if (!peers.has(id)) return;
      peers.delete(id);
      pc.close();
      if (joined) peer.onLeave?.();
    };
    reliable.onclose = leave;
    pc.onconnectionstatechange = () => {
      if (isGone(pc)) leave();
    };
    setTimeout(() => {
      if (!joined) leave();
    }, PAD_JOIN_TIMEOUT_MS);

    return peer;
  }

  connectToSignalling();
}

export function joinRoom(room) {
  return new Promise((resolve, reject) => {
    const id = randomId(16);
    const { pc, lossy, reliable } = createPeerConnection();
    const enqueue = createSequentialQueue();
    const ws = new WebSocket(signallingUrl(room, { role: 'pad', id }));
    let settled = false;

    const fail = reason => {
      if (settled) return;
      settled = true;
      pc.close();
      ws.close();
      reject(new Error(reason));
    };

    const joinTimeout = setTimeout(() => fail('Could not reach the game'), PAD_JOIN_TIMEOUT_MS);

    const sendSignal = data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ data }));
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ candidate });
    };

    ws.onopen = () => enqueue(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ sdp: pc.localDescription });
    });

    ws.onmessage = ({ data: raw }) => {
      const { data } = JSON.parse(raw);
      enqueue(async () => {
        if (data?.sdp) {
          await pc.setRemoteDescription(data.sdp);
        } else if (data?.candidate) {
          await pc.addIceCandidate(data.candidate);
        }
      });
    };

    ws.onclose = () => fail('Game not found');

    reliable.onopen = () => {
      settled = true;
      clearTimeout(joinTimeout);
      ws.close();

      const connection = {
        onMessage: null,
        onClose: null,
        sendReliable: msg => sendJson(reliable, msg),
        sendLossy: msg => sendJson(lossy, msg),
      };
      reliable.onmessage = ({ data }) => connection.onMessage?.(JSON.parse(data));

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        pc.close();
        connection.onClose?.();
      };
      reliable.onclose = close;
      pc.onconnectionstatechange = () => {
        if (isGone(pc)) close();
      };

      resolve(connection);
    };
  });
}
