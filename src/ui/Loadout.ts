import * as THREE from 'three';
import { buildGunGeometry, previewMaterial } from '../game/models';
import { ATT, Build, ITEMS, ItemId, Loadout, SLOT_NAMES, Slot, WEAPON, WEAPONS, computeStats, defaultBuild, ratings } from '../game/weapons';

const KEY = 'voxelwars.loadout.v1';

export function loadSavedLoadout(): Loadout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const l = JSON.parse(raw) as Loadout;
      if (WEAPON[l.primary.id] && WEAPON[l.secondary.id] && ITEMS.some((i) => i.id === l.item)) return l;
    }
  } catch {
    /* ignore */
  }
  return {
    primary: { id: 'ar', build: { ...defaultBuild(WEAPON.ar), optic: 'reddot', underbarrel: 'vgrip' } },
    secondary: { id: 'rocket', build: defaultBuild(WEAPON.rocket) },
    item: 'frag',
  };
}

function save(l: Loadout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

type Tab = 'primary' | 'secondary' | 'item';

/** Loadout editor with a live 3D weapon preview. */
export class LoadoutEditor {
  private root: HTMLElement;
  private tab: Tab = 'primary';
  loadout: Loadout;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  private gun: THREE.Mesh | null = null;
  private raf = 0;
  private yaw = 0.6;
  private drag = false;
  private lastX = 0;
  onClose: (l: Loadout) => void = () => {};

  constructor() {
    this.root = document.getElementById('loadout')!;
    this.loadout = loadSavedLoadout();
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x404830, 1.6);
    const dir = new THREE.DirectionalLight(0xfff0d8, 2.4);
    dir.position.set(2, 3, 2);
    const rim = new THREE.DirectionalLight(0x8ab4ff, 1.4);
    rim.position.set(-3, 1, -2);
    this.scene.add(hemi, dir, rim);
    this.camera.position.set(0, 0.25, 2.1);
    this.camera.lookAt(0, 0, 0);
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    this.render();
    const canvas = this.root.querySelector('#preview') as HTMLCanvasElement;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      canvas.addEventListener('pointerdown', (e) => {
        this.drag = true;
        this.lastX = e.clientX;
      });
      window.addEventListener('pointerup', () => (this.drag = false));
      window.addEventListener('pointermove', (e) => {
        if (!this.drag) return;
        this.yaw += (e.clientX - this.lastX) * 0.01;
        this.lastX = e.clientX;
      });
    }
    this.updatePreview();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const c = this.renderer!.domElement;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * this.renderer!.getPixelRatio()) || c.height !== Math.round(h * this.renderer!.getPixelRatio())) {
        this.renderer!.setSize(w, h, false);
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
      }
      if (!this.drag) this.yaw += 0.006;
      if (this.gun) this.gun.rotation.y = this.yaw;
      this.renderer!.render(this.scene, this.camera);
    };
    cancelAnimationFrame(this.raf);
    loop();
  }

  close() {
    this.root.classList.remove('open');
    cancelAnimationFrame(this.raf);
    save(this.loadout);
    this.onClose(this.loadout);
  }

  private slotOf(): { id: string; build: Build } {
    return this.tab === 'secondary' ? this.loadout.secondary : this.loadout.primary;
  }

  private updatePreview() {
    if (this.tab === 'item') {
      if (this.gun) this.gun.visible = false;
      return;
    }
    const sel = this.slotOf();
    const def = WEAPON[sel.id];
    const geo = buildGunGeometry(def, sel.build);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const center = bb.getCenter(new THREE.Vector3());
    geo.translate(-center.x, -center.y, -center.z);
    const size = bb.getSize(new THREE.Vector3()).length();
    if (this.gun) {
      this.gun.geometry.dispose();
      this.gun.geometry = geo;
      this.gun.visible = true;
    } else {
      this.gun = new THREE.Mesh(geo, previewMaterial);
      this.scene.add(this.gun);
    }
    this.gun.scale.setScalar(1.25 / Math.max(0.4, size));
  }

  private render() {
    const l = this.loadout;
    const tabs = (['primary', 'secondary', 'item'] as Tab[])
      .map((t) => {
        const label = t === 'item' ? 'Equipment' : t === 'primary' ? 'Primary' : 'Secondary';
        const sub = t === 'item' ? ITEMS.find((i) => i.id === l.item)!.name : WEAPON[(t === 'primary' ? l.primary : l.secondary).id].name;
        return `<button class="tab ${this.tab === t ? 'on' : ''}" data-tab="${t}"><span>${label}</span><b>${sub}</b></button>`;
      })
      .join('');
    let body = '';
    if (this.tab === 'item') {
      body = `<div class="items">${ITEMS.map((it) => `<button class="card ${l.item === it.id ? 'on' : ''}" data-item="${it.id}"><b>${it.name}</b><span>× ${it.count}</span><p>${it.desc}</p></button>`).join('')}</div>`;
    } else {
      const sel = this.slotOf();
      const other = this.tab === 'primary' ? l.secondary.id : l.primary.id;
      const def = WEAPON[sel.id];
      const stats = computeStats(def, sel.build);
      const base = computeStats(def, defaultBuild(def));
      const rs = ratings(stats), rb = ratings(base);
      const grid = WEAPONS.map(
        (w) => `<button class="card wcard ${w.id === sel.id ? 'on' : ''} ${w.id === other ? 'dim' : ''}" data-weapon="${w.id}" ${w.id === other ? 'title="Already in your other slot"' : ''}><b>${w.name}</b><span>${w.category}</span></button>`,
      ).join('');
      const slots = (Object.entries(def.slots) as [Slot, string[]][])
        .map(([slot, list]) => {
          const cur = sel.build[slot] ?? list[0];
          const chips = list.map((id) => `<button class="chip ${id === cur ? 'on' : ''}" data-slot="${slot}" data-att="${id}" title="${ATT[id].desc}">${ATT[id].name}</button>`).join('');
          return `<div class="slot"><label>${SLOT_NAMES[slot]}</label><div class="chips">${chips}</div><p class="att-desc">${ATT[cur].desc}</p></div>`;
        })
        .join('');
      const bars = rs
        .map((r, i) => {
          const d = r.v - rb[i].v;
          const cls = Math.abs(d) < 0.005 ? '' : d > 0 ? 'up' : 'down';
          return `<div class="stat"><label>${r.label}</label><div class="bar"><i style="width:${Math.round(Math.min(r.v, rb[i].v) * 100)}%"></i><em class="${cls}" style="left:${Math.round(Math.min(r.v, rb[i].v) * 100)}%;width:${Math.round(Math.abs(d) * 100)}%"></em></div></div>`;
        })
        .join('');
      const facts = `<div class="facts"><span><b>${Math.round(stats.damage * stats.pellets + stats.blastDamage)}</b> dmg</span><span><b>${Math.round(stats.rpm)}</b> rpm</span><span><b>${stats.mag}</b> mag</span><span><b>${stats.reload.toFixed(1)}s</b> reload</span><span><b>${Math.round(stats.range)}m</b> range</span></div>`;
      body = `
        <div class="wgrid">${grid}</div>
        <div class="detail">
          ${facts}
          <div class="stats">${bars}</div>
          <div class="slots">${slots}</div>
        </div>`;
      (this.root.querySelector('#lo-wtitle') as HTMLElement).innerHTML = `<h2>${def.name}</h2><span>${def.category}</span><p>${def.blurb}</p>`;
    }
    this.root.querySelector('.lo-body')!.innerHTML = `<div class="tabs">${tabs}</div>${body}`;
    this.root.classList.toggle('items-tab', this.tab === 'item');
    this.bind();
  }

  private bind() {
    const l = this.loadout;
    this.root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.render();
        this.updatePreview();
      }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-weapon]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.weapon!;
        const slot = this.tab === 'secondary' ? 'secondary' : 'primary';
        const otherSlot = slot === 'primary' ? 'secondary' : 'primary';
        if (l[otherSlot].id === id) {
          // swap the two slots instead of duplicating
          const tmp = l[slot];
          l[slot] = l[otherSlot];
          l[otherSlot] = tmp;
        } else if (l[slot].id !== id) l[slot] = { id, build: defaultBuild(WEAPON[id]) };
        this.render();
        this.updatePreview();
      }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-att]').forEach((b) =>
      b.addEventListener('click', () => {
        const sel = this.slotOf();
        sel.build[b.dataset.slot as Slot] = b.dataset.att!;
        this.render();
        this.updatePreview();
      }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-item]').forEach((b) =>
      b.addEventListener('click', () => {
        l.item = b.dataset.item as ItemId;
        this.render();
      }),
    );
  }
}
