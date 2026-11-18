import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-700.css';
import './App.css';
import { renderSVG } from 'uqr';
import { Game, World, spawnPlayer } from './game/sim.js';
import { hostRoom, randomId } from './net/rtc.js';
import knight from './units/knight.js';
import thief from './units/thief.js';
import wizard from './units/wizard.js';

const heroes = { knight, thief, wizard };

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext("2d");

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function rect({ x, y, w, h, c }) {
  ctx.save();
  ctx.translate(-w/2, -h/2);
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function circle({ x, y, r, c }) {
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = c;
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function player({ x, y, r, c, dx, dy, a, k, n, f }) {
  let dir;
  const len = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2));
  const cos = dx / len;
  const sin = dy / len;

  if (cos >= Math.SQRT1_2) {
    dir = 'right';
  } else if (cos <= - Math.SQRT1_2) {
    dir = 'left';
  }

  if (sin >= Math.SQRT1_2) {
    dir = 'down';
  } else if (sin <= - Math.SQRT1_2) {
    dir = 'up';
  }

  const frame = heroes[n][dir];
  const pixel = Math.ceil(r * 1.25 * Math.SQRT2 / 12);
  const offset = pixel * frame.length / 2;

  ctx.save();
  ctx.translate(Math.ceil(x) - offset, Math.ceil(y) - offset);
  for (let i = 0; i < (frame.length * k / 100); i ++) {
    for (let j = 0; j < frame[i].length; j ++) {
      if (frame[i][j] === 0) continue;
      ctx.fillStyle = frame[i][j] === 'brand' ? c : frame[i][j];
      ctx.fillRect(j * pixel, i * pixel, pixel, pixel);
    }
  }

  if (f > 0) {
    ctx.font = "16px 'Pixelify Sans'";
    ctx.fillStyle = '#fff';
    const textSize = ctx.measureText(f);
    ctx.fillText(f, offset - textSize.width / 2, -10);
  }

  ctx.restore();

  if (a) {
    ctx.save();

    ctx.translate(Math.ceil(x), Math.ceil(y));

    let alpha = Math.acos(cos);
    const dalpha = Math.PI / 4;

    if (sin < 0) {
      alpha = -alpha;
    }

    ctx.beginPath();
    ctx.arc(0, 0, r * 1.4, alpha - dalpha, alpha + dalpha);

    const d = r * 1.4 * Math.cos(dalpha);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
    ctx.arc(dx * d, dy * d, r * 1.4 * Math.sin(dalpha), alpha + Math.PI / 2, alpha - Math.PI / 2, true);
    ctx.fill();

    ctx.restore();
  }
}

function update(objs) {
  clear();

  objs.forEach(obj => {
    switch (obj.t) {
      case 'player':
        player(obj);
        break;
      case 'circle':
        circle(obj);
        break;
      case 'rect':
        rect(obj);
        break;
      default:
        break;
    }
  });
}

const MAX_FRAME_STEP_MS = 100;
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

const world = new World(window.innerWidth, window.innerHeight);
const game = new Game(world);

function fitToWindow() {
  canvas.width = world.w = window.innerWidth;
  canvas.height = world.h = window.innerHeight;
}

fitToWindow();
window.addEventListener('resize', fitToWindow);

const HOST_CREDENTIALS_KEY = 'hostCredentials';

function newHostCredentials() {
  return { room: randomId(10), hostKey: randomId(40) };
}

function savedHostCredentials() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HOST_CREDENTIALS_KEY) ?? 'null');
    return saved?.room && saved?.hostKey ? saved : null;
  } catch {
    return null;
  }
}

function rememberHostCredentialsForReloads(credentials) {
  try {
    sessionStorage.setItem(HOST_CREDENTIALS_KEY, JSON.stringify(credentials));
    return true;
  } catch {
    return false;
  }
}

function padUrlReachableFromPhone(room) {
  const url = new URL(`pad.html#${room}`, location.href);
  const devLanAddress = import.meta.env.DEV_LAN_ADDRESS;
  if (devLanAddress && LOOPBACK_HOSTNAMES.includes(url.hostname)) {
    url.hostname = devLanAddress;
  }
  return url.href;
}

const aboutDialog = document.querySelector('.about');
document.querySelector('.info-button').addEventListener('click', () => aboutDialog.showModal());
function isOutside(element, { clientX, clientY }) {
  const box = element.getBoundingClientRect();
  return clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom;
}

aboutDialog.addEventListener('click', event => {
  if (event.target === aboutDialog && isOutside(aboutDialog, event)) aboutDialog.close();
});

const lobby = document.querySelector('.lobby');
const statusEl = lobby.querySelector('.lobby__status');
const STATUS_TEXT = {
  connecting: 'Connecting…',
  ready: 'Scan to join',
  offline: 'Offline — retrying…',
  busy: 'Too many games right now — retrying in a minute',
};

const JOIN_CODE_COLORS = { blackColor: '#3b302a', whiteColor: '#f4e8d8' };

function showJoinCode(room) {
  const joinUrl = padUrlReachableFromPhone(room);
  lobby.querySelector('.lobby__qr').innerHTML = renderSVG(joinUrl, { border: 2, ...JOIN_CODE_COLORS });
  lobby.querySelector('.lobby__link').href = joinUrl;
}

function showPlayers() {
  const count = world.objs.filter(o => o.type === 'player').length;
  lobby.querySelector('.lobby__count').textContent = count ? `${count} playing` : '';
}

function addPlayerFor(peer) {
  let hero = null;
  let newestJoystickSeq = 0;
  const isOutOfOrder = msg => msg.seq <= newestJoystickSeq;
  const isInWorld = () => world.objs.includes(hero);

  function spawnHero() {
    hero = spawnPlayer(world, peer);
    world.add(hero);
    showPlayers();
    peer.sendReliable({ type: 'init', data: { color: hero.c } });
  }

  peer.onMessage = msg => {
    switch (msg.type) {
      case 'nipple':
        if (isOutOfOrder(msg)) break;
        newestJoystickSeq = msg.seq;
        hero.setDirection(msg.data.x, msg.data.y);
        break;
      case 'btn':
        hero.hit(msg.data);
        break;
      case 'respawn':
        if (!isInWorld()) spawnHero();
        break;
      default:
        break;
    }
  };
  peer.onLeave = () => {
    world.remove(hero);
    showPlayers();
  };
  spawnHero();
}

function startHosting(credentials) {
  rememberHostCredentialsForReloads(credentials);
  showJoinCode(credentials.room);
  hostRoom(credentials, {
    onStatus: status => {
      statusEl.textContent = STATUS_TEXT[status];
    },
    onJoin: addPlayerFor,
    onRoomTaken: () => startHosting(newHostCredentials()),
  });
}

startHosting(savedHostCredentials() ?? newHostCredentials());

let lastFrameTime;
function tick(now) {
  const dtTime = lastFrameTime === undefined ? 0 : Math.min(now - lastFrameTime, MAX_FRAME_STEP_MS);
  lastFrameTime = now;

  const objectCountBefore = world.objs.length;
  game.update(dtTime);
  if (world.objs.length !== objectCountBefore) showPlayers();

  update(world.objs.map(obj => obj.toJSON()));
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
