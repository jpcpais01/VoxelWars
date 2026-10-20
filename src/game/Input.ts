/** Keyboard, mouse and twin-stick touch input. */
export interface Stick {
  active: boolean;
  id: number;
  ox: number;
  oy: number;
  x: number; // -1..1
  y: number;
}

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseX = window.innerWidth / 2;
  mouseY = window.innerHeight * 0.4;
  lmb = false;
  rmb = false;
  wheel = 0;
  touch = false;
  move: Stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  look: Stick = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  touchButtons = new Set<string>();
  touchTaps = new Set<string>();
  enabled = false;
  private stickR = 60;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.lmb = this.rmb = false;
    });
    el.addEventListener('mousemove', (e) => {
      if (e.movementX || e.movementY) this.touch = false;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.lmb = true;
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    // touch: left half = move stick, right half = aim/fire stick
    el.addEventListener('touchstart', (e) => this.onTouch(e, 'start'), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouch(e, 'move'), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouch(e, 'end'), { passive: false });
    el.addEventListener('touchcancel', (e) => this.onTouch(e, 'end'), { passive: false });
  }

  private onTouch(e: TouchEvent, phase: 'start' | 'move' | 'end') {
    this.touch = true;
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (phase === 'start') {
        const left = t.clientX < window.innerWidth * 0.45;
        const s = left ? this.move : this.look;
        if (s.active) continue;
        s.active = true;
        s.id = t.identifier;
        s.ox = t.clientX;
        s.oy = t.clientY;
        s.x = s.y = 0;
      } else {
        for (const s of [this.move, this.look]) {
          if (!s.active || s.id !== t.identifier) continue;
          if (phase === 'end') {
            s.active = false;
            s.x = s.y = 0;
          } else {
            let dx = (t.clientX - s.ox) / this.stickR;
            let dy = (t.clientY - s.oy) / this.stickR;
            const l = Math.hypot(dx, dy);
            if (l > 1) {
              // drag the origin so the stick follows the thumb
              s.ox = t.clientX - (dx / l) * this.stickR;
              s.oy = t.clientY - (dy / l) * this.stickR;
              dx /= l;
              dy /= l;
            }
            s.x = dx;
            s.y = dy;
          }
        }
      }
    }
  }

  down(code: string) {
    return this.keys.has(code);
  }

  hit(code: string) {
    return this.pressed.has(code);
  }

  endFrame() {
    this.pressed.clear();
    this.wheel = 0;
    this.touchTaps.clear();
  }
}
