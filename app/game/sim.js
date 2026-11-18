export class World {
  constructor(w, h) {
    // in points (px)
    this.h = h;
    this.w = w;
    this.objs = [];
  }

  add(obj) {
    this.objs.push(obj);
  }

  remove(obj) {
    this.objs = this.objs.filter((o) => o !== obj);
  }

  setIn(obj) {
    if (obj.type === "circle" || obj.type === "player") {
      obj.x = Math.min(Math.max(0 + obj.r, obj.x), this.w - obj.r);
      obj.y = Math.min(Math.max(0 + obj.r, obj.y), this.h - obj.r);
    } else if (obj.type === "rect") {
      obj.x = Math.min(Math.max(0 + obj.w / 2, obj.x), this.w - obj.w / 2);
      obj.y = Math.min(Math.max(0 + obj.h / 2, obj.y), this.h - obj.h / 2);
    }
  }
}

class Obj {
  constructor(x, y, c, isStatic) {
    this.x = x;
    this.y = y;
    this.c = c;
    this.isStatic = isStatic === undefined ? true : isStatic;
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      c: this.c,
      t: "obj",
    };
  }
}

export class Rect extends Obj {
  constructor(x, y, w, h, c, isStatic) {
    super(x, y, c, isStatic);
    this.w = w;
    this.h = h;
    this.type = "rect";
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      w: this.w,
      h: this.h,
      c: this.c,
      t: this.type,
    };
  }
}

export class Circle extends Obj {
  constructor(x, y, r, c, isStatic) {
    super(x, y, c, isStatic);

    this.r = r;
    this.type = "circle";
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      r: this.r,
      c: this.c,
      t: this.type,
    };
  }
}

export class Player extends Circle {
  // speed in points per second, atack speed raz per second
  constructor(peer, x, y, r, c, speed, ats, name) {
    super(x, y, r, c, false);
    this.peer = peer;

    this.speed = speed;

    this.name = name;
    this.type = "player";
    this.dx = 0;
    this.dy = 0;

    this.dirX = 0;
    this.dirY = 1;
    this.frags = 0;

    // hit vars
    this.as = ats;
    this.sendHit = false;
    this.sendFor = 250;
    this.timeLastSend = 0.0;

    this.timeLastHit = 0.0;

    // dead vars
    this.dead = false;
    this.deadTime = 1000;
    this.hp = 100;
  }

  hit(cs) {
    this.isHit = cs === "down";
  }

  setDirection(dx, dy) {
    this.dx = dx;
    this.dy = dy;

    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      const n = this.normalize(this.dx, this.dy);

      this.dirX = n.x;
      this.dirY = n.y;
    }
  }

  isAttack(objs) {
    const points = [
      {
        x: this.x + this.dirX * this.r * 1.45,
        y: this.y + this.dirY * this.r * 1.45,
      },
    ];

    this.points = points;

    objs.forEach((obj) => {
      if (obj !== this) {
        points.forEach((point) => {
          const dist = Math.sqrt(
            Math.pow(obj.x - point.x, 2) + Math.pow(obj.y - point.y, 2),
          );
          if (dist < obj.r + 15) {
            obj.kill();
            this.frags += 1;
          }
        });
      }
    });
  }

  kill() {
    this.dead = true;
    this.frags = 0;
  }

  update(world, dtTime) {
    let dt = {
      dx: (this.dx * dtTime * this.speed) / 1000,
      dy: (this.dy * dtTime * this.speed) / 1000,
    };

    dt = world.objs.reduce(
      (acc, obj) => (this !== obj ? this.hitTest(obj, acc.dx, acc.dy) : acc),
      dt,
    );

    if (!this.dead) {
      if (this.isHit && this.timeLastHit > this.as * 1000) {
        this.timeLastHit = 0.0;
        this.timeLastSend = 0.0;
        this.isAttack(world.objs);

        this.sendHit = true;
      }

      if (this.timeLastSend > this.sendFor) {
        this.sendHit = false;
      }
    } else {
      this.hp -= (dtTime / this.deadTime) * 100;
    }

    this.timeLastSend += dtTime;
    this.timeLastHit += dtTime;

    this.x += dt.dx;
    this.y += dt.dy;

    world.setIn(this);
  }

  normalize(x, y) {
    const d = Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
    return { x: x / d, y: y / d };
  }

  toJSON() {
    return Object.assign(super.toJSON(), {
      dx: this.dirX,
      dy: this.dirY,
      t: this.type,
      a: this.sendHit,
      k: this.hp,
      n: this.name,
      p: this.points,
      f: this.frags,
    });
  }

  hitTest(obj, dx, dy) {
    switch (obj.type) {
      case "player":
      case "circle": {
        const x = this.x + dx;
        const y = this.y + dy;
        const r2 = this.r + obj.r;
        const dist = Math.sqrt(Math.pow(x - obj.x, 2) + Math.pow(y - obj.y, 2));
        if (dist < r2) {
          const newY = obj.y + ((y - obj.y) * (r2 + 1)) / dist;
          const newX = obj.x + ((x - obj.x) * (r2 + 1)) / dist;

          return { dx: newX - this.x, dy: newY - this.y };
        }
        return { dx, dy };
      }

      default:
        return { dx, dy };
    }
  }
}

export class Game {
  constructor(world) {
    this.world = world;
  }

  update(dtTime) {
    this.world.objs
      .filter((obj) => !obj.isStatic)
      .forEach((obj) => {
        obj.update(this.world, dtTime);
      });

    this.world.objs = this.world.objs.filter((obj) => {
      if (obj.hp < 5) {
        obj.peer?.sendReliable({ type: "disable" });
      }
      return !(obj.hp < 5);
    });
  }
}

const heroes = ["knight", "thief", "wizard"];
const playerSize = 20;

export function randomColor() {
  return `hsl(${Math.floor(Math.random() * 360)} 100% 60%)`;
}

export function spawnPlayer(world, peer) {
  return new Player(
    peer,
    Math.round(Math.random() * world.w - playerSize),
    Math.round(Math.random() * world.h - playerSize),
    playerSize,
    randomColor(),
    425,
    1,
    heroes[Math.round(Math.random() * (heroes.length - 1))],
  );
}
