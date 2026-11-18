import './pad.css';
import { joinRoom } from './net/rtc.js';

const statusEl = document.querySelector('.pad__status');
const room = location.hash.slice(1);

let conn = null;
let disabled = true;
let joystickSeq = 0;
let connecting = false;

function enable(color) {
  disabled = false;
  statusEl.textContent = '';
  document.body.style.backgroundColor = color;
}

function disable(text) {
  disabled = true;
  statusEl.textContent = text;
  document.body.style.backgroundColor = '#ccc';
}

function joystickMessage(x, y) {
  return { type: 'nipple', seq: ++joystickSeq, data: { x, y } };
}

function sendJoystickPosition(x, y) {
  conn?.sendLossy(joystickMessage(x, y));
}

function sendJoystickRelease() {
  conn?.sendReliable(joystickMessage(0, 0));
}

async function connect() {
  if (!/^[a-z0-9]{6,32}$/.test(room)) {
    disable('No game code — scan the QR code on the game screen');
    return;
  }
  disable('Connecting…');
  connecting = true;
  try {
    conn = await joinRoom(room);
  } catch (err) {
    disable(`${err.message}. Tap to retry`);
    return;
  } finally {
    connecting = false;
  }
  conn.onMessage = msg => {
    switch (msg.type) {
      case 'init':
        enable(msg.data.color);
        break;
      case 'disable':
        releaseAllInput();
        disable('You died. Tap to respawn');
        break;
      default:
        break;
    }
  };
  conn.onClose = () => {
    releaseAllInput();
    conn = null;
    disable('Disconnected. Tap to rejoin');
  };
}

connect();

function restartWithNewRoom() {
  location.reload();
}

window.addEventListener('hashchange', restartWithNewRoom);

// blocks

const boob = document.querySelector('.pad__boob');
const nipple = document.querySelector('.pad__nipple');
const btn = document.querySelector('.pad__btn');
const pad = document.querySelector('.pad');
const safeArea = document.querySelector('.safe-area');
let screenToPad = touch => ({ x: touch.clientX, y: touch.clientY });
let nippleSide;
let nippleTouch = null;
let btnTouch = null;
let boobR;
let boobInR;

const ACTIVE_LISTENER = { passive: false };

// nipple

function posNipple({ x: x, y: y }) {
  nipple.style.top = y + 'px';
  nipple.style.left = x + 'px';
}

function checkIntersection(el, x, y, r, rm = 0) {
  const _x = x - el.offsetLeft;
  const _y = y - el.offsetTop;
  if (Math.pow(_x - r + rm, 2) + Math.pow(_y - r + rm, 2) < Math.pow(r, 2)) {
    return { x: _x, y: _y };
  }
  return false;
}

function padX(touch) {
  return screenToPad(touch).x;
}

function padY(touch) {
  return screenToPad(touch).y;
}

function handleNippleTouch(touch) {
  let intersection = checkIntersection(boob, padX(touch), padY(touch), boobInR, -(nipple.offsetWidth / 2));
  if (!intersection) {
    const x1 = boob.offsetLeft + boobR;
    const y1 = boob.offsetTop + boobR;
    const x2 = padX(touch);
    const y2 = padY(touch);
    const d = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    intersection = {
      x: ((x2 - x1) / d * boobInR) + boobR,
      y: ((y2 - y1) / d * boobInR) + boobR
    };
  }
  posNipple(intersection);
  sendJoystickPosition((intersection.x - boobR) / boobInR, (intersection.y - boobR) / boobInR);
}

function releaseNipple() {
  nippleTouch = null;
  nipple.classList.add('i-back');
  nipple.classList.remove('i-active');
  posNipple({ x: boobR, y: boobR });
  sendJoystickRelease();
}

function upButton() {
  btnTouch = null;
  btn.classList.remove('i-active');
  conn?.sendReliable({ type: 'btn', data: 'up' });
}

function releaseAllInput() {
  if (nippleTouch !== null) releaseNipple();
  if (btnTouch !== null) upButton();
}

function lastTargetTouch(e) {
  return e.targetTouches[e.targetTouches.length - 1];
}

function requestRespawn() {
  conn.sendReliable({ type: 'respawn' });
  statusEl.textContent = 'Respawning…';
}

document.addEventListener('touchstart', () => {
  if (!disabled || connecting) return;
  if (conn) {
    requestRespawn();
  } else {
    location.reload();
  }
});

boob.addEventListener('touchstart', e => {
  e.preventDefault();
  if (nippleTouch !== null || disabled) return;
  nipple.classList.add('i-active');
  nipple.classList.remove('i-back');
  nippleTouch = lastTargetTouch(e).identifier;
  handleNippleTouch(lastTargetTouch(e));
}, ACTIVE_LISTENER);

btn.addEventListener('touchstart', e => {
  e.preventDefault();
  if (btnTouch !== null || disabled) return;
  btn.classList.add('i-active');
  btnTouch = lastTargetTouch(e).identifier;
  conn?.sendReliable({ type: 'btn', data: 'down' });
}, ACTIVE_LISTENER);

window.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    switch (touch.identifier) {
      case nippleTouch:
        handleNippleTouch(touch);
        break;
      case btnTouch:
        if (!checkIntersection(btn, padX(touch), padY(touch), btn.offsetWidth / 2)) {
          upButton();
        }
        break;
      default:
        break;
    }
  }
}, ACTIVE_LISTENER);

function handleTouchEnd(e) {
  for (const touch of e.changedTouches) {
    switch (touch.identifier) {
      case nippleTouch:
        releaseNipple();
        break;
      case btnTouch:
        upButton();
        break;
      default:
        break;
    }
  }
}

window.addEventListener('touchend', handleTouchEnd);
window.addEventListener('touchcancel', handleTouchEnd);

function preventBrowserGesture(e) {
  e.preventDefault();
}

for (const gesture of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'selectstart']) {
  document.addEventListener(gesture, preventBrowserGesture, ACTIVE_LISTENER);
}

function ignoreWhereUnsupported() {}

function isFullscreen() {
  return Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);
}

function enterFullscreenLandscape() {
  const root = document.documentElement;
  const requestFullscreen = root.requestFullscreen ?? root.webkitRequestFullscreen;
  if (isFullscreen() || !requestFullscreen) return;

  Promise.resolve(requestFullscreen.call(root, { navigationUI: 'hide' }))
    .then(() => screen.orientation?.lock?.('landscape'))
    .catch(ignoreWhereUnsupported);
}

let screenWakeLock = null;

function keepScreenAwake() {
  if (screenWakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;

  screenWakeLock = navigator.wakeLock.request('screen')
    .then(lock => {
      lock.addEventListener('release', () => {
        screenWakeLock = null;
      });
      return lock;
    })
    .catch(() => {
      screenWakeLock = null;
    });
}

window.addEventListener('touchend', () => {
  enterFullscreenLandscape();
  keepScreenAwake();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepScreenAwake();
  } else {
    releaseAllInput();
  }
});

window.addEventListener('blur', releaseAllInput);

// resize

function placePadAsLandscape() {
  const safe = safeArea.getBoundingClientRect();
  const screenIsPortrait = safe.height > safe.width;

  if (screenIsPortrait) {
    pad.style.width = safe.height + 'px';
    pad.style.height = safe.width + 'px';
    pad.style.transform = `translate(${safe.right}px, ${safe.top}px) rotate(90deg)`;
    screenToPad = touch => ({ x: touch.clientY - safe.top, y: safe.right - touch.clientX });
  } else {
    pad.style.width = safe.width + 'px';
    pad.style.height = safe.height + 'px';
    pad.style.transform = `translate(${safe.left}px, ${safe.top}px)`;
    screenToPad = touch => ({ x: touch.clientX - safe.left, y: touch.clientY - safe.top });
  }
}

function resize() {
  placePadAsLandscape();
  boob.style.width = boob.offsetHeight + 'px';
  boob.style.left = boob.offsetTop + 'px';
  btn.style.width = btn.offsetHeight + 'px';
  btn.style.right = boob.style.left;
  nippleSide = nipple.offsetWidth;
  boobR = boob.offsetWidth / 2;
  boobInR = boobR - nipple.offsetWidth / 2
  nipple.style.marginLeft = nipple.style.marginTop = (- nippleSide / 2) + 'px';
  if (nippleTouch === null) {
    posNipple({ x: boobR, y: boobR });
  }
};

resize();

window.addEventListener('resize', resize);
