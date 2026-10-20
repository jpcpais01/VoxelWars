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
  /** accumulated look motion since the last frame, in pixels (mouse) or touch points */
  lookDX = 0;
  lookDY = 0;
  /** pointer is captured for mouse look */
  locked = false;
  /** this browser has no pointer lock at all: look with the plain mouse instead */
  freeLook = false;
  /** called whenever capture is gained, lost or refused */
  onLockChange: () => void = () => {};
  private lookX = 0;
  private lookY = 0;
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
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.lmb = this.rmb = false;
      this.onLockChange();
    });
    // a refused capture (no click behind it, or the browser's cooldown right after Esc) is not
    // final: stay unlocked and capture on the next click, never fall back to edge-bound mouse look
    document.addEventListener('pointerlockerror', () => this.onLockChange());
    window.addEventListener('mousemove', (e) => {
      if (e.movementX || e.movementY) this.touch = false;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (this.enabled && (this.locked || this.freeLook)) {
        // browsers occasionally report a huge jump right after capture
        if (Math.abs(e.movementX) < 400 && Math.abs(e.movementY) < 400) {
          this.lookDX += e.movementX;
          this.lookDY += e.movementY;
        }
      }
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      // the click that captures the pointer does not fire
      if (!this.locked && !this.freeLook) {
        this.capture();
        return;
      }
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

  capture() {
    if (this.touch || this.locked || this.freeLook) return;
    if (!this.el.requestPointerLock) {
      this.freeLook = true;
      return;
    }
    try {
      const r = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => this.onLockChange());
    } catch {
      this.onLockChange();
    }
  }

  /** playing with a mouse but the pointer is not captured yet: the next click captures it */
  get needsCapture() {
    return this.enabled && !this.touch && !this.locked && !this.freeLook;
  }

  release() {
    if (document.pointerLockElement) document.exitPointerLock();
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
        if (!left) {
          this.lookX = t.clientX;
          this.lookY = t.clientY;
        }
      } else {
        for (const s of [this.move, this.look]) {
          if (!s.active || s.id !== t.identifier) continue;
          if (phase === 'end') {
            s.active = false;
            s.x = s.y = 0;
          } else if (s === this.look) {
            // right thumb drags the view
            this.lookDX += t.clientX - this.lookX;
            this.lookDY += t.clientY - this.lookY;
            this.lookX = t.clientX;
            this.lookY = t.clientY;
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

  /** take the look motion gathered since the last call */
  takeLook() {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = this.lookDY = 0;
    return r;
  }

  endFrame() {
    this.pressed.clear();
    this.wheel = 0;
    this.touchTaps.clear();
  }
}
