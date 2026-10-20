import * as THREE from 'three';
import { CORE_HP, MAP_D, MAP_W, TEAM_BLUE, VOXEL, WATER_Y, WX, WY, WZ } from '../core/config';

/** minimap texel = 0.8 m */
const MAP_STEP = Math.round(0.8 / VOXEL);
import type { FeedEntry, Game } from '../game/Game';
import { Soldier } from '../game/Soldier';
import { ITEMS } from '../game/weapons';
import { MATS } from '../world/materials';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class HUD {
  private overlay = $<HTMLCanvasElement>('overlay');
  private ctx = this.overlay.getContext('2d')!;
  private mini = $<HTMLCanvasElement>('minimap');
  private mctx = this.mini.getContext('2d')!;
  private mapImg = document.createElement('canvas');
  private mapT = 0;
  private feedEl = $('feed');
  private msgEl = $('messages');
  private cross = $('crosshair');
  private crossRing = $('cross-ring');
  private scopeEl = $('scope');
  private hitEl = $('hitmarker');
  private dmgEl = $('dmgdirs');
  private respawnEl = $('respawn');
  private scoreEl = $('scoreboard');
  private fpsEl = $('fps');
  private v = new THREE.Vector3();
  private fpsAcc = 0;
  private fpsN = 0;
  showFps = false;
  private lastHp = 100;
  private scoreFeed = $('score-feed');
  private streakEl = $('streak');
  private myScoreEl = $('my-score');
  private shownScore = 0;
  private nums: { x: number; y: number; z: number; v: number; t: number; head: boolean; kill: boolean; jx: number }[] = [];

  constructor(private game: Game) {
    this.mapImg.width = WX / MAP_STEP;
    this.mapImg.height = WZ / MAP_STEP;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = window.innerWidth * dpr;
    this.overlay.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ms = this.mini.clientWidth || 170;
    this.mini.width = ms * dpr;
    this.mini.height = ms * dpr;
    this.mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------------------------ events
  kill(e: FeedEntry) {
    const row = document.createElement('div');
    row.className = 'feed-row';
    const cls = (t: number) => (t === TEAM_BLUE ? 'blue' : 'red');
    const p = this.game.player;
    if (e.killer === p.name || e.victim === p.name) row.classList.add('me');
    row.innerHTML = `<span class="${cls(e.killerTeam)}">${esc(e.killer)}</span><span class="wpn">${esc(e.weapon || '✖')}${e.special ? ' ◎' : ''}</span><span class="${cls(e.victimTeam)}">${esc(e.victim)}</span>`;
    this.feedEl.prepend(row);
    while (this.feedEl.children.length > 6) this.feedEl.lastElementChild?.remove();
    setTimeout(() => row.classList.add('fade'), 6000);
    setTimeout(() => row.remove(), 7000);
  }

  hitmarker(kill: boolean, head: boolean) {
    this.hitEl.className = kill ? 'show kill' : head ? 'show head' : 'show';
    void this.hitEl.offsetWidth;
    this.game.audio.hitmarker(kill);
    clearTimeout((this.hitEl as unknown as { _t: number })._t);
    (this.hitEl as unknown as { _t: number })._t = window.setTimeout(() => (this.hitEl.className = ''), kill ? 380 : 160);
  }

  /** "+100 Elimination" style toasts; big ones also get the centre banner */
  score(label: string, pts: number, big = false) {
    const el = document.createElement('div');
    el.className = `sc ${big ? 'big' : ''}`;
    el.innerHTML = `<b>+${pts}</b><span>${esc(label)}</span>`;
    this.scoreFeed.prepend(el);
    while (this.scoreFeed.children.length > 4) this.scoreFeed.lastElementChild?.remove();
    setTimeout(() => el.classList.add('fade'), 1900);
    setTimeout(() => el.remove(), 2400);
    if (big) {
      this.streakEl.textContent = label;
      this.streakEl.className = '';
      void this.streakEl.offsetWidth;
      this.streakEl.className = 'show';
      this.game.audio.hitmarker(true);
    }
  }

  /** floating damage numbers for hits the player lands */
  damage(x: number, y: number, z: number, v: number, head: boolean, kill: boolean) {
    // merge rapid hits on the same spot (shotgun pellets, bursts) into one rising number
    const last = this.nums[this.nums.length - 1];
    if (last && this.game.time - last.t < 0.12 && Math.hypot(last.x - x, last.z - z) < 1.2 && !last.kill) {
      last.v += v;
      last.head ||= head;
      last.kill ||= kill;
      return;
    }
    this.nums.push({ x, y, z, v, t: this.game.time, head, kill, jx: (Math.random() - 0.5) * 18 });
    if (this.nums.length > 24) this.nums.shift();
  }

  hurt(dir: THREE.Vector3, amount: number) {
    const el = document.createElement('div');
    el.className = 'dmg';
    // dir points from attacker to us; the indicator shows where it came from, relative to the view
    const yaw = this.game.pc.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const ax = -dir.x, az = -dir.z;
    const ang = Math.atan2(ax * -fz + az * fx, ax * fx + az * fz);
    el.style.transform = `rotate(${ang}rad)`;
    el.style.opacity = String(Math.min(1, 0.4 + amount / 40));
    this.dmgEl.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  message(text: string, kind: 'info' | 'warn' | 'good') {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    this.msgEl.appendChild(el);
    while (this.msgEl.children.length > 3) this.msgEl.firstElementChild?.remove();
    setTimeout(() => el.classList.add('fade'), 2600);
    setTimeout(() => el.remove(), 3300);
  }

  // ------------------------------------------------------------------------------ frame
  update(dt: number, mouseX: number, mouseY: number, touch: boolean) {
    const g = this.game;
    const p = g.player;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fpsEl.textContent = this.showFps ? `${Math.round(this.fpsN / this.fpsAcc)} fps · ${Math.round(g.renderer.dynScale * 100)}%` : '';
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    // cores + timer
    for (const [i, id] of [[0, 'core-blue'], [1, 'core-red']] as const) {
      const c = g.cores[i];
      const fill = $(id).querySelector('.fill') as HTMLElement;
      fill.style.width = `${(c.hp / CORE_HP) * 100}%`;
      $(id).classList.toggle('hit', g.time - c.lastHit < 0.25);
      ($(id).querySelector('.num') as HTMLElement).textContent = `${Math.ceil((c.hp / CORE_HP) * 100)}%`;
    }
    const tl = Math.max(0, g.timeLeft);
    $('timer').textContent = `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, '0')}`;
    const alive = (t: number) => g.soldiers.filter((s) => s.team === t && s.alive).length;
    $('alive-blue').textContent = String(alive(0));
    $('alive-red').textContent = String(alive(1));

    // vitals
    const hpFill = $('hp-fill');
    hpFill.style.width = `${p.hp}%`;
    hpFill.classList.toggle('low', p.hp < 35);
    $('hp-num').textContent = String(Math.ceil(p.hp));
    if (p.hp < this.lastHp - 0.5) $('vitals').classList.add('flash');
    else $('vitals').classList.remove('flash');
    this.lastHp = p.hp;
    const item = ITEMS.find((i) => i.id === p.item)!;
    $('item').innerHTML = `<b>${p.c4.length > 0 ? 'DETONATE' : item.name}</b><span>${p.c4.length > 0 ? `${p.c4.length} armed` : `× ${p.itemCount}`}</span><kbd>${touch ? '' : 'G'}</kbd>`;
    // weapons
    const w = p.weapon;
    const o = p.weapons[1 - p.current];
    $('wpn-name').textContent = w.def.name;
    $('wpn-cat').textContent = w.def.category;
    $('ammo').textContent = String(w.ammo);
    $('reserve').textContent = `/ ${w.reserve}`;
    $('ammo').classList.toggle('low', w.ammo <= Math.ceil(w.stats.mag * 0.25));
    $('wpn-alt').textContent = `${touch ? '⇄' : 'Q'} ${o.def.name} · ${o.ammo}`;
    const rl = $('reload-bar');
    if (w.reloading) {
      rl.style.opacity = '1';
      (rl.firstElementChild as HTMLElement).style.width = `${(1 - w.reloadT / w.stats.reload) * 100}%`;
    } else rl.style.opacity = '0';
    const spin = $('spin');
    spin.style.opacity = w.stats.spinUp > 0 ? '1' : '0';
    if (w.stats.spinUp > 0) (spin.firstElementChild as HTMLElement).style.width = `${w.spin * 100}%`;

    // crosshair: centred, opens with the current spread; hidden while looking down the sights
    const vm = g.viewmodel;
    const ads = vm.adsAmount;
    if (p.alive && ads < 0.6) {
      this.cross.style.display = 'block';
      this.cross.style.transform = `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)`;
      this.cross.style.opacity = String(1 - ads / 0.6);
      const cam = g.renderer.camera;
      const r = Math.max(4, (Math.tan(p.spread()) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) * (window.innerHeight / 2));
      this.crossRing.style.width = this.crossRing.style.height = `${r * 2}px`;
      this.cross.classList.toggle('enemy', !!g.pc.aimTarget && g.pc.aimTarget.team !== p.team);
      this.cross.classList.toggle('reload', w.reloading);
      this.cross.classList.toggle('sprint', p.sprinting);
    } else this.cross.style.display = 'none';
    // scope overlay for high-power optics
    const scoped = p.alive && vm.scopedIn;
    this.scopeEl.className = scoped ? `on ${p.weapon.build.optic ?? ''}` : '';
    void mouseX;
    void mouseY;

    // respawn
    if (!p.alive && !g.over) {
      this.respawnEl.style.display = 'flex';
      const left = Math.max(0, p.respawnAt - g.time);
      $('respawn-time').textContent = left.toFixed(1);
      $('respawn-by').textContent = p.lastAttacker && p.lastAttacker !== p ? `Eliminated by ${p.lastAttacker.name} · ${p.lastAttacker.weapon.def.name}` : 'You were eliminated';
    } else this.respawnEl.style.display = 'none';

    // running score (counts up)
    if (Math.round(this.shownScore) !== Math.round(p.score)) {
      this.shownScore += (p.score - this.shownScore) * Math.min(1, dt * 8) + Math.sign(p.score - this.shownScore) * 0.5;
      if (Math.abs(p.score - this.shownScore) < 1) this.shownScore = p.score;
      this.myScoreEl.textContent = `${Math.round(this.shownScore).toLocaleString()} pts`;
    }

    // scoreboard
    if (g.input.down('Tab')) {
      this.scoreEl.style.display = 'block';
      this.renderScoreboard();
    } else this.scoreEl.style.display = 'none';

    this.drawOverlay();
    this.mapT -= dt;
    if (g.minimapDirty && this.mapT <= 0) {
      this.buildMap();
      g.minimapDirty = false;
      this.mapT = 1.5;
    }
    this.drawMinimap();
  }

  private renderScoreboard() {
    const g = this.game;
    const rows = (team: number) =>
      g.soldiers
        .filter((s) => s.team === team)
        .sort((a, b) => b.score - a.score)
        .map((s) => `<tr class="${s.isPlayer ? 'me' : ''} ${s.alive ? '' : 'dead'}"><td>${esc(s.name)}</td><td>${s.weapon.def.name}</td><td>${Math.round(s.score)}</td><td>${s.kills}</td><td>${s.assists}</td><td>${s.deaths}</td><td>${Math.round(s.coreDamage)}</td></tr>`)
        .join('');
    const head = '<tr><th>Name</th><th>Weapon</th><th>Score</th><th>K</th><th>A</th><th>D</th><th>Core</th></tr>';
    this.scoreEl.innerHTML = `<div class="sb-team blue"><h3>Blue</h3><table>${head}${rows(0)}</table></div><div class="sb-team red"><h3>Red</h3><table>${head}${rows(1)}</table></div>`;
  }

  private project(x: number, y: number, z: number) {
    const cam = this.game.renderer.camera;
    const behind = this.v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse).z > 0;
    const v = this.v.set(x, y, z).project(cam);
    if (behind) {
      // mirror points behind the camera so edge markers point the right way
      v.x = -v.x * 1e3;
      v.y = -Math.abs(v.y) * 1e3 - 1e3;
    }
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, on: !behind && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  private drawOverlay() {
    const g = this.game;
    const ctx = this.ctx;
    const p = g.player;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const thermal = p.alive && p.ads && p.weapon.stats.thermal;
    ctx.font = '600 11px "Chakra Petch", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const s of g.soldiers) {
      if (!s.alive || s === p) continue;
      const ally = s.team === p.team;
      const intel = g.intel[p.team].get(s.id);
      const seen = ally || (intel && g.time - intel.t < 0.6) || s.markedUntil > g.time;
      const sc = this.project(s.pos.x, s.pos.y + 2.25, s.pos.z);
      if (!sc.on) continue;
      if (thermal && !ally) {
        const dx = s.pos.x - p.pos.x, dz = s.pos.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        const dot = (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) / d;
        if (d < 55 && dot > 0.6) {
          const b = this.project(s.pos.x, s.pos.y + 0.9, s.pos.z);
          ctx.strokeStyle = 'rgba(255,140,60,0.95)';
          ctx.lineWidth = 2;
          ctx.shadowColor = '#ff7a2a';
          ctx.shadowBlur = 12;
          ctx.strokeRect(b.x - 12, b.y - 24, 24, 40);
          ctx.shadowBlur = 0;
        }
      }
      if (!seen) continue;
      const w = 34;
      ctx.fillStyle = 'rgba(8,12,10,0.55)';
      ctx.fillRect(sc.x - w / 2 - 1, sc.y - 1, w + 2, 6);
      ctx.fillStyle = ally ? '#5aa2ff' : '#ff5a4a';
      ctx.fillRect(sc.x - w / 2, sc.y, (w * s.hp) / 100, 4);
      if (ally) {
        ctx.fillStyle = 'rgba(230,240,255,0.92)';
        ctx.fillText(s.name, sc.x, sc.y - 4);
      }
      if (s.markedUntil > g.time && !ally) {
        ctx.fillStyle = '#ffcf4a';
        ctx.fillText('◆', sc.x, sc.y - 6);
      }
    }
    // enemy core marker when off screen or far
    const ec = g.cores[1 - p.team];
    if (ec.alive) {
      const sc = this.project(ec.pos.x, ec.pos.y + 4, ec.pos.z);
      const cx = Math.min(window.innerWidth - 30, Math.max(30, sc.x));
      const cy = Math.min(window.innerHeight - 30, Math.max(70, sc.y));
      const off = !sc.on;
      ctx.fillStyle = off ? 'rgba(255,90,70,0.9)' : 'rgba(255,90,70,0.65)';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx + 8, cy);
      ctx.lineTo(cx, cy + 9);
      ctx.lineTo(cx - 8, cy);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      const d = Math.hypot(ec.pos.x - p.pos.x, ec.pos.z - p.pos.z);
      ctx.fillText(`${Math.round(d)}m`, cx, cy + 22);
    }
    // own core warning
    const oc = g.cores[p.team];
    if (g.time - oc.lastHit < 3) {
      const sc = this.project(oc.pos.x, oc.pos.y + 4, oc.pos.z);
      const cx = Math.min(window.innerWidth - 30, Math.max(30, sc.x));
      const cy = Math.min(window.innerHeight - 30, Math.max(70, sc.y));
      ctx.fillStyle = `rgba(90,160,255,${0.5 + 0.5 * Math.sin(g.time * 12)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    // grenade / c4 warnings near the player
    for (const pr of g.projectiles) {
      if ((pr.kind === 'frag' || pr.kind === 'c4') && pr.team !== p.team && Math.hypot(pr.pos.x - p.pos.x, pr.pos.z - p.pos.z) < 7) {
        const sc = this.project(pr.pos.x, pr.pos.y + 0.6, pr.pos.z);
        ctx.fillStyle = '#ffcf4a';
        ctx.font = '700 16px system-ui';
        ctx.fillText('⚠', sc.x, sc.y);
        ctx.font = '600 11px "Chakra Petch", system-ui, sans-serif';
      }
    }
    // laser dot where the crosshair lands (hip fire only)
    if (p.alive && p.weapon.stats.laser && g.viewmodel.adsAmount < 0.5) {
      const b = this.project(g.pc.aimPoint.x, g.pc.aimPoint.y, g.pc.aimPoint.z);
      if (b.on) {
        ctx.fillStyle = 'rgba(255,40,30,0.9)';
        ctx.shadowColor = '#ff2a1a';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    // damage numbers
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      const age = g.time - n.t;
      const life = n.kill ? 1.1 : 0.8;
      if (age > life) {
        this.nums.splice(i, 1);
        continue;
      }
      const sc = this.project(n.x, n.y + 0.4, n.z);
      if (!sc.on) continue;
      const k = age / life;
      const pop = age < 0.08 ? 1 + (0.08 - age) * 6 : 1;
      const size = (n.kill ? 19 : n.head ? 16 : 13) * pop;
      ctx.font = `800 ${size.toFixed(1)}px "Chakra Petch", system-ui, sans-serif`;
      ctx.globalAlpha = 1 - k * k;
      const x = sc.x + n.jx * k, y = sc.y - 26 * Math.sqrt(k) - 6;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(10,14,12,0.75)';
      ctx.strokeText(String(Math.round(n.v)), x, y);
      ctx.fillStyle = n.kill ? '#ff6a4d' : n.head ? '#ffd24a' : '#f4f7f2';
      ctx.fillText(String(Math.round(n.v)), x, y);
      ctx.globalAlpha = 1;
    }
    ctx.font = '600 11px "Chakra Petch", system-ui, sans-serif';

    // touch sticks
    const inp = g.input;
    if (inp.touch) {
      for (const s of [inp.move]) {
        if (!s.active) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.ox, s.oy, 60, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = s === inp.look && Math.hypot(s.x, s.y) > 0.55 ? 'rgba(255,110,80,0.6)' : 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.arc(s.ox + s.x * 60, s.oy + s.y * 60, 24, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private buildMap() {
    const w = this.game.world;
    const c = this.mapImg.getContext('2d')!;
    const img = c.createImageData(this.mapImg.width, this.mapImg.height);
    const col = new THREE.Color();
    for (let mx = 0; mx < this.mapImg.width; mx++)
      for (let mz = 0; mz < this.mapImg.height; mz++) {
        const x = mx * MAP_STEP, z = mz * MAP_STEP;
        const k = x * WZ + z;
        const top = w.top[k];
        const fl = w.floor[k];
        const m = w.vox[k * WY + Math.max(0, top - 1)];
        let r, g, b;
        if (fl * VOXEL < WATER_Y && top * VOXEL < WATER_Y + 0.5) {
          const depth = WATER_Y - fl * VOXEL;
          r = 40 - depth * 10;
          g = 120 - depth * 15;
          b = 140 - depth * 8;
        } else {
          col.setHex(MATS[m]?.color ?? 0x666666);
          const shade = 0.7 + Math.min(0.5, (top * VOXEL) / 24);
          r = col.r * 255 * shade;
          g = col.g * 255 * shade;
          b = col.b * 255 * shade;
          // wait: Color.setHex converts to linear, so lift back up roughly
          r = Math.sqrt(r / 255) * 255;
          g = Math.sqrt(g / 255) * 255;
          b = Math.sqrt(b / 255) * 255;
          if ((top - fl) * VOXEL > 2.4) {
            r *= 0.75;
            g *= 0.8;
            b *= 0.75;
          }
        }
        const i = (mz * this.mapImg.width + mx) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    c.putImageData(img, 0, 0);
  }

  private drawMinimap() {
    const g = this.game;
    const ctx = this.mctx;
    const S = this.mini.clientWidth || 170;
    const p = g.player;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, S, S, 14);
    ctx.clip();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.mapImg, 0, 0, S, S);
    ctx.globalAlpha = 1;
    const sx = S / MAP_W, sz = S / MAP_D;
    // view cone
    {
      const yaw = g.pc.yaw;
      const half = THREE.MathUtils.degToRad(g.renderer.camera.fov / 2) * g.renderer.camera.aspect;
      const R = 30;
      const cx = p.pos.x * sx, cz = p.pos.z * sz;
      const grd = ctx.createRadialGradient(cx, cz, 0, cx, cz, R * sx);
      grd.addColorStop(0, 'rgba(255,246,192,0.35)');
      grd.addColorStop(1, 'rgba(255,246,192,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(cx, cz);
      for (let i = 0; i <= 8; i++) {
        const a = yaw - half + (i / 8) * half * 2;
        ctx.lineTo(cx + Math.sin(a) * R * sx, cz + Math.cos(a) * R * sz);
      }
      ctx.closePath();
      ctx.fill();
    }
    // cores
    for (const c of g.cores) {
      ctx.fillStyle = c.team === 0 ? '#4d95ff' : '#ff5a48';
      ctx.globalAlpha = c.alive ? 1 : 0.3;
      ctx.fillRect(c.pos.x * sx - 5, c.pos.z * sz - 5, 10, 10);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(c.pos.x * sx - 5, c.pos.z * sz - 5, 10, 10);
      ctx.globalAlpha = 1;
    }
    for (const s of g.soldiers) {
      if (!s.alive || s === p) continue;
      const ally = s.team === p.team;
      if (!ally) {
        const intel = g.intel[p.team].get(s.id);
        const seen = (intel && g.time - intel.t < 3) || s.markedUntil > g.time || (s.spottedUntil > g.time && Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z) < 45);
        if (!seen) continue;
      }
      ctx.fillStyle = ally ? '#6db0ff' : '#ff5a48';
      ctx.beginPath();
      ctx.arc(s.pos.x * sx, s.pos.z * sz, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // player arrow
    ctx.save();
    ctx.translate(p.pos.x * sx, p.pos.z * sz);
    ctx.rotate(-p.yaw + Math.PI);
    ctx.fillStyle = '#fff6c0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export { Soldier };
