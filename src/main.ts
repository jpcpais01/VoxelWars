import './styles.css';
import * as THREE from 'three';
import { registerSW } from 'virtual:pwa-register';
import { TEAM_BLUE, TEAM_NAMES, Team } from './core/config';
import { Renderer, Quality } from './render/Renderer';
import { Water } from './render/water';
import { World } from './world/World';
import { generateWorld } from './world/generator';
import { ChunkManager } from './world/ChunkManager';
import { Audio } from './audio/Audio';
import { Input } from './game/Input';
import { Game } from './game/Game';
import { HUD } from './ui/HUD';
import { LoadoutEditor } from './ui/Loadout';
import { ITEMS, WEAPON } from './game/weapons';
import { PATCH_NOTES } from './data/patchnotes';
import { shared } from './render/shaderlib';

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------------------------ settings
interface Settings {
  quality: Quality | 'auto';
  volume: number;
  zoom: number;
  fps: boolean;
}
const SETTINGS_KEY = 'voxelwars.settings.v1';
const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function loadSettings(): Settings {
  const def: Settings = { quality: 'auto', volume: 0.8, zoom: 1, fps: false };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...def, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return def;
}
const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
function resolvedQuality(): Quality {
  if (settings.quality !== 'auto') return settings.quality;
  const small = Math.min(screen.width, screen.height) < 700;
  return coarse || small ? 'medium' : 'high';
}

if (coarse) document.body.classList.add('touch');
window.addEventListener('touchstart', () => document.body.classList.add('touch'), { passive: true, once: true });

// ------------------------------------------------------------------------------------ boot
const canvas = $<HTMLCanvasElement>('game');
const renderer = new Renderer(canvas);
const world = new World();
const audio = new Audio();
const input = new Input(canvas);
let chunks: ChunkManager;
let game: Game;
let hud: HUD | null = null;
const editor = new LoadoutEditor();

type State = 'loading' | 'menu' | 'playing';
let state: State = 'loading';
let paused = false;
let menuAngle = 0.4;

const loadFill = $('load-fill');
const loadLabel = $('load-label');
async function progress(p: number, label: string) {
  loadFill.style.width = `${Math.round(p * 100)}%`;
  loadLabel.textContent = label;
  await nextFrame();
}

async function boot() {
  renderer.setQuality(resolvedQuality());
  const info = await generateWorld(world, 1337, async (p, label) => progress(p * 0.6, label));
  chunks = new ChunkManager(world, info.grassDensity);
  renderer.scene.add(chunks.group);
  await chunks.buildAll(async (p) => progress(0.6 + p * 0.35, 'Meshing the valley'));
  chunks.setGrass(renderer.q.grass);
  renderer.setWater(new Water(world));
  await progress(0.97, 'Briefing the squads');
  game = new Game(renderer, world, info, chunks, audio, input, {
    onKill: (e) => hud?.kill(e),
    onHitMarker: (kill, head) => hud?.hitmarker(kill, head),
    onPlayerHurt: (dir, amount) => hud?.hurt(dir, amount),
    onMessage: (text, kind) => hud?.message(text, kind),
    onEnd: (winner) => showEnd(winner),
  });
  // compile shaders before the first visible frame so the menu doesn't stutter
  renderer.gl.compile(renderer.scene, renderer.camera);
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { vw: { game, renderer, world } });
  await progress(1, 'Ready');
  $('loading').classList.add('hidden');
  state = 'menu';
  $('menu').classList.remove('hidden');
  renderMenuKit();
  if (new URLSearchParams(location.search).has('deploy')) {
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]deploy(=1)?/, '').replace(/^&/, '?'));
    deploy();
  }
}

// ------------------------------------------------------------------------------------ menus
function renderMenuKit() {
  const l = editor.loadout;
  const item = ITEMS.find((i) => i.id === l.item)!;
  $('menu-kit').innerHTML = `<div class="kit-row"><span>Primary</span><b>${WEAPON[l.primary.id].name}</b></div><div class="kit-row"><span>Secondary</span><b>${WEAPON[l.secondary.id].name}</b></div><div class="kit-row"><span>Equipment</span><b>${item.name}</b></div>`;
}

function openPanel(id: string) {
  audio.uiClick();
  $(id).classList.add('open');
  input.enabled = false;
}
function closePanel(id: string) {
  audio.uiClick(0.7);
  $(id).classList.remove('open');
  refreshInputEnabled();
}
function anyPanelOpen() {
  return document.querySelectorAll('.panel-screen.open').length > 0;
}
function refreshInputEnabled() {
  input.enabled = state === 'playing' && !paused && !anyPanelOpen();
  document.body.classList.toggle('playing', input.enabled);
}

document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const panel = b.closest('.panel-screen') as HTMLElement;
    closePanel(panel.id);
  }),
);

function openLoadout() {
  audio.uiClick();
  input.enabled = false;
  editor.open();
}
editor.onClose = (l) => {
  renderMenuKit();
  if (state === 'playing') {
    game.player.pendingLoadout = JSON.parse(JSON.stringify(l));
    if (!game.player.alive) hud?.message('New loadout ready for your next deploy', 'good');
    else hud?.message('Loadout applies on respawn', 'info');
  }
  refreshInputEnabled();
};
$('lo-done').addEventListener('click', () => editor.close());

// settings panel
const qualityBtns = $('set-quality').querySelectorAll<HTMLButtonElement>('button');
function syncSettingsUI() {
  qualityBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === settings.quality));
  $<HTMLInputElement>('set-volume').value = String(settings.volume);
  $<HTMLInputElement>('set-zoom').value = String(settings.zoom);
  $<HTMLInputElement>('set-fps').checked = settings.fps;
}
function applySettings() {
  const q = resolvedQuality();
  if (q !== renderer.quality) {
    renderer.setQuality(q);
    chunks?.setGrass(renderer.q.grass);
  }
  audio.setVolume(settings.volume);
  if (game?.pc) game.pc.zoom = settings.zoom;
  if (hud) hud.showFps = settings.fps;
  saveSettings();
}
qualityBtns.forEach((b) =>
  b.addEventListener('click', () => {
    settings.quality = b.dataset.q as Settings['quality'];
    audio.uiClick();
    syncSettingsUI();
    applySettings();
  }),
);
$<HTMLInputElement>('set-volume').addEventListener('input', (e) => {
  settings.volume = +(e.target as HTMLInputElement).value;
  applySettings();
});
$<HTMLInputElement>('set-zoom').addEventListener('input', (e) => {
  settings.zoom = +(e.target as HTMLInputElement).value;
  applySettings();
});
$<HTMLInputElement>('set-fps').addEventListener('change', (e) => {
  settings.fps = (e.target as HTMLInputElement).checked;
  applySettings();
});
syncSettingsUI();

// patch notes
$('patch-body').innerHTML = PATCH_NOTES.map(
  (g) => `<section class="group"><div class="hr">${g.hour}</div><h2>${g.title}</h2><ul>${g.entries.map((e) => `<li>${e}</li>`).join('')}</ul></section>`,
).join('');

// first gesture unlocks audio
const unlockAudio = () => {
  audio.init();
  audio.setVolume(settings.volume);
};
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

$('btn-deploy').addEventListener('click', () => deploy());
$('btn-loadout').addEventListener('click', openLoadout);
$('btn-settings').addEventListener('click', () => openPanel('settings'));
$('btn-patch').addEventListener('click', () => openPanel('patch'));
$('btn-help').addEventListener('click', () => openPanel('help'));

$('p-resume').addEventListener('click', () => setPaused(false));
$('p-loadout').addEventListener('click', openLoadout);
$('p-settings').addEventListener('click', () => openPanel('settings'));
$('p-quit').addEventListener('click', () => location.reload());
$('respawn-loadout').addEventListener('click', openLoadout);
$('e-again').addEventListener('click', () => {
  location.href = `${location.pathname}?deploy=1`;
});
$('e-loadout').addEventListener('click', openLoadout);

function setPaused(p: boolean) {
  if (state !== 'playing' || game.over) return;
  paused = p;
  $('pause').classList.toggle('open', p);
  if (p) {
    input.keys.clear();
    input.lmb = input.rmb = false;
    input.touchButtons.clear();
  }
  audio.uiClick(0.8);
  refreshInputEnabled();
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || state !== 'playing') return;
  if (editor.isOpen) editor.close();
  else if ($('settings').classList.contains('open')) closePanel('settings');
  else setPaused(!paused);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing' && !game.over) setPaused(true);
});

// touch buttons
document.querySelectorAll<HTMLElement>('[data-touch]').forEach((b) => {
  const k = b.dataset.touch!;
  const on = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    input.touch = true;
    input.touchButtons.add(k);
    b.classList.add('on');
  };
  const off = (e: Event) => {
    e.preventDefault();
    input.touchButtons.delete(k);
    b.classList.remove('on');
  };
  b.addEventListener('touchstart', on, { passive: false });
  b.addEventListener('touchend', off, { passive: false });
  b.addEventListener('touchcancel', off, { passive: false });
});
document.querySelectorAll<HTMLElement>('[data-tap]').forEach((b) => {
  const k = b.dataset.tap!;
  b.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.touch = true;
      if (k === 'pause') setPaused(true);
      else input.touchTaps.add(k);
    },
    { passive: false },
  );
});

// ------------------------------------------------------------------------------------ match
function deploy() {
  if (state !== 'menu') return;
  unlockAudio();
  audio.uiClick();
  state = 'playing';
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  renderer.shadowExtent = 34;
  game.start('You', JSON.parse(JSON.stringify(editor.loadout)));
  hud = new HUD(game);
  applySettings();
  refreshInputEnabled();
  hud.message('Destroy the red core. Protect yours.', 'info');
}

function showEnd(winner: Team) {
  const win = winner === TEAM_BLUE;
  const banner = $('end-banner');
  banner.className = win ? 'win' : 'lose';
  banner.innerHTML = `<h1>${win ? 'Victory' : 'Defeat'}</h1><span>${TEAM_NAMES[winner]} team destroyed the enemy core</span>`;
  const rows = (team: number) =>
    game.soldiers
      .filter((s) => s.team === team)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map((s) => `<tr class="${s.isPlayer ? 'me' : ''}"><td>${s.name}</td><td>${s.kills}</td><td>${s.deaths}</td><td>${Math.round(s.damageDealt)}</td></tr>`)
      .join('');
  const table = (team: number) =>
    `<div class="end-team ${team === TEAM_BLUE ? 'blue' : 'red'}"><h3>${TEAM_NAMES[team]}</h3><table><thead><tr><th>Name</th><th>K</th><th>D</th><th>Dmg</th></tr></thead><tbody>${rows(team)}</tbody></table></div>`;
  $('end-stats').innerHTML = table(0) + table(1);
  $('end').classList.add('open');
  refreshInputEnabled();
}

// ------------------------------------------------------------------------------------ frame loop
const orbitTarget = new THREE.Vector3();
let last = performance.now();
let time = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.0005, (now - last) / 1000));
  last = now;
  time += dt;
  if (state === 'loading') return;

  if (state === 'menu') {
    // slow cinematic flyover around the valley
    menuAngle += dt * 0.035;
    const o = game.info.menuOrbit;
    orbitTarget.set(o.x + Math.cos(menuAngle * 0.7) * 10, 6, o.z + Math.sin(menuAngle * 0.7) * 10);
    const cam = renderer.camera;
    cam.position.set(orbitTarget.x + Math.cos(menuAngle) * 62, 44, orbitTarget.z + Math.sin(menuAngle) * 62);
    cam.lookAt(orbitTarget);
    renderer.focusTarget.copy(orbitTarget);
    renderer.shadowExtent = 62;
    renderer.updateShadowCamera(orbitTarget);
    shared.uCutA.value.w = 0;
    shared.uCutB.value.w = 0;
    game.particles.update(dt);
    chunks.update(3);
  } else if (state === 'playing') {
    if (!paused) {
      game.update(dt);
      game.updateView(dt);
      hud!.update(dt, input.mouseX, input.mouseY, input.touch);
    }
  }
  game.particles.depthTex.value = renderer.halfTex;
  renderer.render(paused ? 0 : dt, time);
  renderer.adapt(dt);
}

window.addEventListener('resize', () => renderer.resize());
requestAnimationFrame(frame);
boot().catch((err) => {
  console.error(err);
  loadLabel.textContent = 'Something went wrong while building the valley. Please reload.';
});
