import './styles.css';
import * as THREE from 'three';
import { registerSW } from 'virtual:pwa-register';
import { CORE_HP, TEAM_BLUE, TEAM_NAMES, Team } from './core/config';
import { LIGHTING, LightingId, Renderer, Quality } from './render/Renderer';
import { Water } from './render/water';
import { World } from './world/World';
import { generateWorld } from './world/generator';
import { ChunkManager } from './world/ChunkManager';
import { Audio } from './audio/Audio';
import { Input } from './game/Input';
import { Difficulty, Game } from './game/Game';
import type { Soldier } from './game/Soldier';
import { HUD } from './ui/HUD';
import { LoadoutEditor } from './ui/Loadout';
import { ITEMS, WEAPON } from './game/weapons';
import { PATCH_NOTES } from './data/patchnotes';
import { shared } from './render/shaderlib';
import { OnlineUI } from './ui/Online';
import { keepParams } from './net/link';
import type { HostSession } from './net/host';
import type { PeerSession } from './net/peer';
import type { Welcome } from './net/session';

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------------------------ settings
interface Settings {
  quality: Quality | 'auto';
  volume: number;
  zoom: number;
  sens: number;
  fov: number;
  fps: boolean;
  difficulty: Difficulty;
  lighting: LightingId;
  minutes: number;
  view: ViewSetting;
}
type ViewId = 'near' | 'medium' | 'far' | 'max';
type ViewSetting = ViewId | 'auto';
/** render distance presets: how far you see, how far full detail and sun shadows reach */
const VIEW: Record<ViewId, { dist: number; lod: number; shadow: number }> = {
  near: { dist: 70, lod: 0.85, shadow: 36 },
  medium: { dist: 110, lod: 0.92, shadow: 40 },
  far: { dist: 170, lod: 1, shadow: 44 },
  max: { dist: 400, lod: 1.1, shadow: 50 },
};
const VIEW_AUTO: Record<Quality, ViewId> = { low: 'near', medium: 'medium', high: 'far', ultra: 'max' };
const SETTINGS_KEY = 'voxelwars.settings.v1';
const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function loadSettings(): Settings {
  const def: Settings = { quality: 'auto', volume: 0.8, zoom: 1, sens: 1, fov: 90, fps: false, difficulty: 'regular', lighting: 'morning', minutes: 15, view: 'auto' };
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
function resolvedView(): ViewId {
  return settings.view === 'auto' ? VIEW_AUTO[resolvedQuality()] : settings.view;
}
/** In a match the render distance setting rules; the menu flyover always shows the whole valley. */
function applyView() {
  if (!chunks) return;
  const v = VIEW[state === 'playing' ? resolvedView() : 'max'];
  renderer.setViewDistance(v.dist);
  chunks.viewDist = state === 'playing' ? v.dist : Infinity;
  chunks.lodScale = renderer.q.lod * v.lod;
  if (state === 'playing') renderer.shadowExtent = v.shadow;
}

// ------------------------------------------------------------------------------------ career
interface Career {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  bestStreak: number;
  bestScore: number;
  coreDamage: number;
}
const CAREER_KEY = 'voxelwars.career.v1';
function loadCareer(): Career {
  const def: Career = { matches: 0, wins: 0, kills: 0, deaths: 0, assists: 0, bestStreak: 0, bestScore: 0, coreDamage: 0 };
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    if (raw) return { ...def, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return def;
}
const career = loadCareer();
function saveCareer() {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    /* ignore */
  }
}

const TIPS = [
  'Shoot out the base of a trunk and the whole tree comes down, on whoever is standing under it.',
  'Rockets and demo charges open new doors into a bunker. Walls are only a suggestion.',
  'Explosives hit cores far harder than bullets. Bring a launcher when you push.',
  'Suppressors keep you off the enemy minimap when you fire.',
  'Bushes and canopies block sight lines. Bots cannot shoot what they cannot see.',
  'Red fuel barrels chain-react. Lure a squad past the supply depot.',
  'Your base supply depot refills ammo and equipment.',
  'Craters next to the river flood. So do the bots who stand in them.',
  'Golden hour casts long shadows: great for spotting movement across the valley.',
  'Aim down sights with the right mouse button. Scopes zoom in, and so does your sensitivity.',
  'Sprinting lowers your gun. Stop a moment before you round a corner.',
  'Assists, headshots, multi-kills and core damage all add to your score.',
];

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
const online = new OnlineUI({
  loadout: () => JSON.parse(JSON.stringify(editor.loadout)),
  settings: () => ({ difficulty: settings.difficulty, minutes: settings.minutes, lighting: settings.lighting }),
  saveSettings: (m) => {
    settings.difficulty = m.difficulty;
    settings.minutes = m.minutes;
    settings.lighting = m.lighting;
    renderer.setLighting(m.lighting);
    saveSettings();
    syncSetup();
  },
  hostStart: (s) => deployHost(s),
  peerWelcome: (s, w) => joinMatch(s, w),
  peerReady: () => enterMatch(),
  openLoadout: () => {
    // the editor opens over the menu; the lobby comes back when it closes
    $('online').classList.remove('open');
    lobbyLoadout = true;
    openLoadout();
  },
  click: () => audio.uiClick(),
  shown: () => syncPauseOverlay(),
  lost: (reason) => connectionLost(reason),
});
/** the live online session, once a match is running */
let net: HostSession | PeerSession | null = null;
let lobbyLoadout = false;

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

const tipEl = $('load-tip');
let tipI = (Math.random() * TIPS.length) | 0;
tipEl.textContent = TIPS[tipI];
const tipTimer = window.setInterval(() => {
  tipEl.style.opacity = '0';
  setTimeout(() => {
    tipI = (tipI + 1) % TIPS.length;
    tipEl.textContent = TIPS[tipI];
    tipEl.style.opacity = '1';
  }, 400);
}, 3200);

async function boot() {
  renderer.setQuality(resolvedQuality());
  const info = await generateWorld(world, 1337, async (p, label) => progress(p * 0.6, label));
  chunks = new ChunkManager(world, info.grassDensity);
  renderer.scene.add(chunks.group);
  await chunks.buildAll(async (p) => progress(0.6 + p * 0.3, 'Meshing the valley'));
  await progress(0.92, 'Baking sky light');
  await chunks.buildSky();
  chunks.setGrass(renderer.q.grass);
  applyView();
  chunks.setView(renderer.camera.position);
  const water = new Water(world);
  water.setFlow(info.flow);
  renderer.setWater(water);
  await progress(0.97, 'Briefing the squads');
  game = new Game(renderer, world, info, chunks, audio, input, {
    onKill: (e) => hud?.kill(e),
    onHitMarker: (kill, head) => hud?.hitmarker(kill, head),
    onPlayerHurt: (dir, amount) => hud?.hurt(dir, amount),
    onMessage: (text, kind) => hud?.message(text, kind),
    onEnd: (winner) => showEnd(winner),
    onScore: (label, pts, big) => hud?.score(label, pts, big),
    onDamage: (x, y, z, v, head, killed) => hud?.damage(x, y, z, v, head, killed),
  });
  renderer.setLighting(settings.lighting);
  // compile shaders before the first visible frame so the menu doesn't stutter
  chunks.primeMaterials();
  renderer.gl.compile(renderer.scene, renderer.camera);
  chunks.updateCutout(0, 0, 0, 0, 0, 0);
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { vw: { game, renderer, world, editor } });
  await progress(1, 'Ready');
  clearInterval(tipTimer);
  $('loading').classList.add('hidden');
  state = 'menu';
  $('menu').classList.remove('hidden');
  renderMenuKit();
  renderCareer();
  const qs = new URLSearchParams(location.search);
  if (qs.has('deploy')) {
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]deploy(=1)?/, '').replace(/^&/, '?'));
    deploy();
  } else if (qs.get('room') || qs.get('host')) {
    // an invite link (or a rematch reload): straight into that room's lobby
    const room = qs.get('room'), host = qs.get('host');
    online.show();
    if (host) void online.host(host.toUpperCase(), qs.has('pub'), 'Rematch room open. Your squad is reloading into it.');
    else void online.join(room!.toUpperCase());
  }
}

// ------------------------------------------------------------------------------------ menus
function renderMenuKit() {
  const l = editor.loadout;
  const item = ITEMS.find((i) => i.id === l.item)!;
  $('menu-kit').innerHTML = `<div class="kit-row"><span>Primary</span><b>${WEAPON[l.primary.id].name}</b></div><div class="kit-row"><span>Secondary</span><b>${WEAPON[l.secondary.id].name}</b></div><div class="kit-row"><span>Equipment</span><b>${item.name}</b></div>`;
}

function renderCareer() {
  const c = career;
  if (!c.matches) {
    $('career').innerHTML = '<span class="empty">No matches yet. Deploy to start your record.</span>';
    return;
  }
  const kd = (c.kills / Math.max(1, c.deaths)).toFixed(2);
  const rows: [string, string | number][] = [
    ['Matches', c.matches],
    ['Wins', `${c.wins} · ${Math.round((c.wins / c.matches) * 100)}%`],
    ['Kills / assists', `${c.kills} / ${c.assists}`],
    ['K/D', kd],
    ['Best streak', c.bestStreak],
    ['Best score', c.bestScore.toLocaleString()],
    ['Core damage', Math.round(c.coreDamage).toLocaleString()],
  ];
  $('career').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
}

// match setup
const DIFF_LABEL: Record<Difficulty, string> = { recruit: 'Recruit', regular: 'Regular', veteran: 'Veteran' };
function syncSetup() {
  const set = (id: string, v: string) => $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  set('set-diff', settings.difficulty);
  set('set-tod', settings.lighting);
  set('set-len', String(settings.minutes));
  $('deploy-sub').textContent = `${DIFF_LABEL[settings.difficulty]} bots · ${LIGHTING[settings.lighting].label} · ${settings.minutes} min`;
}
const bindSeg = (id: string, apply: (v: string) => void) =>
  $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      audio.uiClick();
      apply(b.dataset.v!);
      saveSettings();
      syncSetup();
    }),
  );
bindSeg('set-diff', (v) => (settings.difficulty = v as Difficulty));
bindSeg('set-tod', (v) => {
  settings.lighting = v as LightingId;
  renderer.setLighting(settings.lighting);
});
bindSeg('set-len', (v) => (settings.minutes = +v));
syncSetup();

function openPanel(id: string) {
  audio.uiClick();
  $(id).classList.add('open');
  input.enabled = false;
  input.release();
  syncPauseOverlay();
}
function closePanel(id: string) {
  audio.uiClick(0.7);
  $(id).classList.remove('open');
  refreshInputEnabled();
  syncPauseOverlay();
}
// The pause menu steps aside while Settings or Loadout is on top of it, and comes back when they close.
function syncPauseOverlay() {
  const covered = editor.isOpen || [...document.querySelectorAll('.panel-screen.open')].some((el) => el.id !== 'pause');
  $('pause').classList.toggle('open', paused && !covered);
}
function anyPanelOpen() {
  return document.querySelectorAll('.panel-screen.open').length > 0;
}
function refreshInputEnabled() {
  input.enabled = state === 'playing' && !paused && !anyPanelOpen() && !editor.isOpen && !game?.over;
  document.body.classList.toggle('playing', input.enabled);
  if (input.enabled) input.capture();
  else input.release();
  syncLockHint();
}
function syncLockHint() {
  document.body.classList.toggle('needs-lock', input.needsCapture);
}
input.onLockChange = syncLockHint;

// ------------------------------------------------------------------------------------ fullscreen
const fsBtn = $('btn-fullscreen');
const fsRoot = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
const fsDoc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
const isFullscreen = () => !!(document.fullscreenElement ?? fsDoc.webkitFullscreenElement);
// iPhone Safari has no fullscreen API, and an installed app is already full screen
const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
if ((document.fullscreenEnabled || fsDoc.webkitFullscreenEnabled) && !standalone) fsBtn.classList.remove('hidden');
function syncFullscreen() {
  const on = isFullscreen();
  fsBtn.classList.toggle('on', on);
  fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
  fsBtn.setAttribute('aria-label', fsBtn.title);
}
fsBtn.addEventListener('click', async () => {
  audio.uiClick();
  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else fsDoc.webkitExitFullscreen?.();
    } else {
      if (fsRoot.requestFullscreen) await fsRoot.requestFullscreen({ navigationUI: 'hide' });
      else fsRoot.webkitRequestFullscreen?.();
      // phones play sideways
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (input.touch) o?.lock?.('landscape').catch(() => {});
    }
  } catch {
    /* the browser said no; nothing to undo */
  }
  syncFullscreen();
});
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);

// losing the mouse (Esc, alt-tab) while playing pauses the match
let lastUnlock = 0;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  lastUnlock = performance.now();
  if (state === 'playing' && !paused && input.enabled && !game.over) setPaused(true);
});

document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const panel = b.closest('.panel-screen') as HTMLElement;
    closePanel(panel.id);
  }),
);

// armoury foley: attachments click into place, guns are picked up, everything else ticks
$('loadout').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-att]')) audio.attach();
  else if (t.closest('[data-weapon]')) audio.draw('');
  else if (t.closest('button')) audio.uiClick(0.8);
});

function openLoadout() {
  audio.uiClick();
  input.enabled = false;
  input.release();
  editor.open();
  syncPauseOverlay();
}
editor.onClose = (l) => {
  renderMenuKit();
  online.loadoutChanged(JSON.parse(JSON.stringify(l)));
  if (lobbyLoadout) {
    lobbyLoadout = false;
    if (state === 'menu') $('online').classList.add('open');
  }
  if (state === 'playing') {
    game.player.pendingLoadout = JSON.parse(JSON.stringify(l));
    if (!game.player.alive) hud?.message('New loadout ready for your next deploy', 'good');
    else hud?.message('Loadout applies on respawn', 'info');
  }
  refreshInputEnabled();
  syncPauseOverlay();
};
$('lo-done').addEventListener('click', () => editor.close());

// settings panel
const qualityBtns = $('set-quality').querySelectorAll<HTMLButtonElement>('button');
const viewBtns = $('set-view').querySelectorAll<HTMLButtonElement>('button');
function syncSettingsUI() {
  viewBtns.forEach((b) =>
  b.addEventListener('click', () => {
    settings.view = b.dataset.v as ViewSetting;
    audio.uiClick();
    syncSettingsUI();
    applySettings();
  }),
);
qualityBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === settings.quality));
  viewBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === settings.view));
  const vd = VIEW[resolvedView()].dist;
  $('view-val').textContent = vd >= 400 ? 'whole valley' : `${vd} m`;
  $<HTMLInputElement>('set-volume').value = String(settings.volume);
  $<HTMLInputElement>('set-sens').value = String(settings.sens);
  $<HTMLInputElement>('set-fov').value = String(settings.fov);
  $('fov-val').textContent = `${settings.fov}°`;
  $('sens-val').textContent = settings.sens.toFixed(2);
  $<HTMLInputElement>('set-fps').checked = settings.fps;
}
function applySettings() {
  const q = resolvedQuality();
  if (q !== renderer.quality) {
    renderer.setQuality(q);
    chunks?.setGrass(renderer.q.grass);
  }
  applyView();
  audio.setVolume(settings.volume);
  if (game?.pc) {
    game.pc.sensitivity = settings.sens;
    game.pc.fov = settings.fov;
  }
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
$<HTMLInputElement>('set-sens').addEventListener('input', (e) => {
  settings.sens = +(e.target as HTMLInputElement).value;
  $('sens-val').textContent = settings.sens.toFixed(2);
  applySettings();
});
$<HTMLInputElement>('set-fov').addEventListener('input', (e) => {
  settings.fov = +(e.target as HTMLInputElement).value;
  $('fov-val').textContent = `${settings.fov}°`;
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
// a soft tick when the pointer moves onto a menu button
document.addEventListener('pointerover', (e) => {
  const b = (e.target as HTMLElement).closest?.('button, .wcard, .att, [data-v]');
  if (b && !b.contains(e.relatedTarget as Node | null)) audio.uiHover();
});

$('btn-deploy').addEventListener('click', () => deploy());
$('btn-online').addEventListener('click', () => {
  unlockAudio();
  online.show();
});
$('btn-loadout').addEventListener('click', openLoadout);
$('btn-settings').addEventListener('click', () => openPanel('settings'));
$('btn-patch').addEventListener('click', () => openPanel('patch'));
$('btn-help').addEventListener('click', () => openPanel('help'));

$('p-resume').addEventListener('click', () => setPaused(false));
$('p-loadout').addEventListener('click', openLoadout);
$('p-settings').addEventListener('click', () => openPanel('settings'));
$('p-quit').addEventListener('click', () => quitToMenu());
$('respawn-loadout').addEventListener('click', openLoadout);
$('e-again').addEventListener('click', () => {
  if (net?.role === 'host') {
    // everyone reloads into this room's lobby for another round
    net.rematch();
    const pub = net.info?.isPublic ? '&pub=1' : '';
    setTimeout(() => (location.href = `${location.pathname}?host=${net!.code}${pub}${keepParams()}`), 250);
  } else if (!net) location.href = `${location.pathname}?deploy=1`;
});
$('e-loadout').addEventListener('click', openLoadout);
$('e-menu').addEventListener('click', () => quitToMenu());
$('netmsg-ok').addEventListener('click', () => quitToMenu());

function quitToMenu() {
  online.leave();
  location.href = `${location.pathname}${keepParams().replace('&', '?')}`;
}

/** the online match dropped (host left, connection lost) */
function connectionLost(reason: string) {
  $('netmsg-title').textContent = 'Match over';
  $('netmsg-text').textContent = reason;
  $('netmsg').classList.add('open');
  paused = false;
  syncPauseOverlay();
  if (game) game.over = true;
  refreshInputEnabled();
}

function setPaused(p: boolean) {
  if (state !== 'playing' || game.over) return;
  // online the match keeps running underneath the menu
  paused = p;
  audio.setPaused(p);
  syncPauseOverlay();
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
  // the browser already used this Esc to release the mouse (and we paused for it)
  if (performance.now() - lastUnlock < 400) return;
  if (editor.isOpen) editor.close();
  else if ($('settings').classList.contains('open')) closePanel('settings');
  else setPaused(!paused);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && state === 'menu' && online.isOpen && !editor.isOpen) online.hide();
});
document.addEventListener('visibilitychange', () => {
  audio.setHidden(document.hidden);
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
  game.start('You', JSON.parse(JSON.stringify(editor.loadout)), { difficulty: settings.difficulty, minutes: settings.minutes });
  enterMatch();
}

/** online host: start the match with everyone in the lobby, bots in every empty slot */
function deployHost(s: HostSession) {
  if (state !== 'menu') return;
  const m = s.info.settings;
  renderer.setLighting(m.lighting);
  game.start(s.name, JSON.parse(JSON.stringify(editor.loadout)), { difficulty: m.difficulty, minutes: m.minutes }, { team: s.team, humans: s.lobbyHumans() });
  s.begin(game);
  net = s;
  enterMatch();
}

/** online peer: the host let us in; build the match as it describes it (we deploy once the world is caught up) */
function joinMatch(s: PeerSession, w: Welcome) {
  if (state !== 'menu' || net) return;
  renderer.setLighting(w.settings.lighting);
  game.startClient(
    w.roster.map((r) => ({ ...r, you: r.id === w.you })),
    { difficulty: w.settings.difficulty, minutes: w.settings.minutes },
  );
  s.begin(game);
  net = s;
}

function enterMatch() {
  if (state !== 'menu') return;
  unlockAudio();
  audio.deploy();
  state = 'playing';
  online.inMatch = !!net;
  $('online').classList.remove('open');
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  renderer.shadowForce = true;
  renderer.tiltShift = false;
  hud = new HUD(game);
  applySettings();
  refreshInputEnabled();
  hud.message(`Destroy the ${game.player.team === TEAM_BLUE ? 'red' : 'blue'} core. Protect yours.`, 'info');
  if (net) {
    $('p-quit').textContent = 'Leave match';
    $('e-again').textContent = net.role === 'host' ? 'Rematch (everyone)' : 'Waiting for host';
    ($('e-again') as HTMLButtonElement).disabled = net.role !== 'host';
  }
}

function showEnd(winner: Team) {
  const p = game.player;
  const win = winner === p.team;
  const all = [...game.soldiers];
  const byScore = [...all].sort((a, b) => b.score - a.score);
  const mvp = byScore[0];

  // career
  career.matches++;
  if (win) career.wins++;
  career.kills += p.kills;
  career.deaths += p.deaths;
  career.assists += p.assists;
  career.bestStreak = Math.max(career.bestStreak, p.bestStreak);
  const newBest = Math.round(p.score) > career.bestScore;
  career.bestScore = Math.max(career.bestScore, Math.round(p.score));
  career.coreDamage += p.coreDamage;
  saveCareer();
  renderCareer();

  const banner = $('end-banner');
  banner.className = win ? 'win' : 'lose';
  const coreLeft = Math.round((game.cores[winner].hp / CORE_HP) * 100);
  const how = game.cores[1 - winner].alive ? 'held the stronger core when time ran out' : `breached the enemy core with ${coreLeft}% of theirs intact`;
  banner.innerHTML = `<h1>${win ? 'Victory' : 'Defeat'}</h1><span>${TEAM_NAMES[winner]} team ${how}</span>`;

  const acc = p.pelletsFired ? Math.round((p.pelletsHit / p.pelletsFired) * 100) : 0;
  const rank = byScore.indexOf(p) + 1;
  $('end-me').innerHTML = `<div class="end-card"><h4>Your match${newBest ? ' · new personal best' : ''}</h4><div class="end-nums">
    <div class="big"><b>${Math.round(p.score).toLocaleString()}</b><span>Score · #${rank}</span></div>
    <div><b>${p.kills}</b><span>Kills</span></div>
    <div><b>${p.assists}</b><span>Assists</span></div>
    <div><b>${p.deaths}</b><span>Deaths</span></div>
    <div><b>${acc}%</b><span>Accuracy</span></div>
    <div><b>${Math.round(p.coreDamage)}</b><span>Core dmg</span></div>
  </div></div>`;
  const initials = mvp.name.slice(0, 2).toUpperCase();
  $('end-mvp').innerHTML = `<div class="end-card"><h4>Most valuable</h4><div class="mvp"><div class="crest ${mvp.team === TEAM_BLUE ? 'blue' : 'red'}">${initials}</div><div><b>${esc(mvp.name)}</b><small>${Math.round(mvp.score).toLocaleString()} pts · ${mvp.kills} kills · ${mvp.assists} assists · ${Math.round(mvp.coreDamage)} core dmg</small></div></div></div>`;

  // accolades: each goes to whoever earned it most, if it was earned at all
  const best = (f: (s: Soldier) => number) => {
    let b: Soldier | null = null;
    for (const s of all) if (f(s) > 0 && (!b || f(s) > f(b))) b = s;
    return b;
  };
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const awards: [string, Soldier | null, (s: Soldier) => string][] = [
    ['Top gun', best((s) => s.kills), (s) => pl(s.kills, 'kill')],
    ['Sharpshooter', best((s) => s.headshots), (s) => pl(s.headshots, 'headshot')],
    ['Wingman', best((s) => s.assists), (s) => pl(s.assists, 'assist')],
    ['Siege breaker', best((s) => s.coreDamage), (s) => `${Math.round(s.coreDamage)} core damage`],
    ['Unstoppable', best((s) => (s.bestStreak >= 3 ? s.bestStreak : 0)), (s) => `${s.bestStreak} kill streak`],
    ['Demolitionist', best((s) => s.voxelsDestroyed), (s) => `${s.voxelsDestroyed.toLocaleString()} voxels flattened`],
  ];
  $('end-awards').innerHTML = awards
    .filter(([, s]) => s)
    .map(([t, s, d], i) => `<div class="award" style="animation-delay:${0.15 + i * 0.08}s"><b>${t}</b><span>${s!.isPlayer ? 'You' : esc(s!.name)} · ${d(s!)}</span></div>`)
    .join('');

  const rows = (team: number) =>
    all
      .filter((s) => s.team === team)
      .sort((a, b) => b.score - a.score)
      .map((s) => `<tr class="${s.isPlayer ? 'me' : ''}"><td>${esc(s.name)}</td><td>${Math.round(s.score)}</td><td>${s.kills}</td><td>${s.assists}</td><td>${s.deaths}</td><td>${Math.round(s.coreDamage)}</td></tr>`)
      .join('');
  const table = (team: number) =>
    `<div class="end-team ${team === TEAM_BLUE ? 'blue' : 'red'}"><h3>${TEAM_NAMES[team]}</h3><table><thead><tr><th>Name</th><th>Score</th><th>K</th><th>A</th><th>D</th><th>Core</th></tr></thead><tbody>${rows(team)}</tbody></table></div>`;
  $('end-stats').innerHTML = table(0) + table(1);
  $('end').classList.add('open');
  refreshInputEnabled();
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
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
    if (cam.fov !== 32) {
      cam.fov = 32;
      cam.updateProjectionMatrix();
    }
    cam.position.set(orbitTarget.x + Math.cos(menuAngle) * 62, 44, orbitTarget.z + Math.sin(menuAngle) * 62);
    cam.lookAt(orbitTarget);
    renderer.focusTarget.copy(orbitTarget);
    renderer.shadowExtent = 62;
    renderer.updateShadowCamera(orbitTarget);
    shared.uCutA.value.w = 0;
    shared.uCutB.value.w = 0;
    game.particles.update(dt);
    chunks.update(dt);
  } else if (state === 'playing') {
    // online the match never pauses: the menu just covers it
    if (!paused || net) {
      step(dt);
      game.updateView(dt);
      hud!.update(dt, input.mouseX, input.mouseY, input.touch);
      netBadge(dt);
    }
  }
  game.particles.depthTex.value = renderer.halfTex;
  renderer.render(paused ? 0 : dt, time);
  renderer.adapt(dt);
}

/** one simulation step, with the online session around it */
function step(dt: number) {
  // the host's clock is everyone's clock: a slow frame takes two steps rather than slowing the match
  const n = net?.role === 'host' ? Math.ceil(dt / (1 / 20) - 1e-6) : 1;
  for (let i = 0; i < n; i++) {
    net?.pre(dt / n);
    game.update(dt / n);
    net?.post(dt / n);
  }
}

let badgeT = 0;
function netBadge(dt: number) {
  badgeT -= dt;
  if (badgeT > 0) return;
  badgeT = 0.5;
  const el = $('net-badge');
  if (!net) return void (el.textContent = '');
  const humans = game.soldiers.filter((s) => s.human).length;
  if (net.role === 'host') {
    el.textContent = `Hosting ${net.code} · ${humans} ${humans === 1 ? 'player' : 'players'}`;
    el.className = '';
  } else {
    el.textContent = `${net.code} · ${net.ping} ms`;
    el.className = net.ping > 220 ? 'bad' : net.ping > 120 ? 'slow' : '';
  }
}

// a hidden tab gets no animation frames; an online match still has to run (the host runs it for everyone)
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 40)'], { type: 'text/javascript' })));
let hiddenLast = performance.now();
ticker.onmessage = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - hiddenLast) / 1000);
  hiddenLast = now;
  if (!document.hidden || state !== 'playing' || !net) return;
  step(dt);
  last = now;
};

// closing the tab tells the room at once, rather than after a timeout
window.addEventListener('pagehide', () => online.session?.leave());

window.addEventListener('resize', () => renderer.resize());
requestAnimationFrame(frame);
boot().catch((err) => {
  console.error(err);
  loadLabel.textContent = 'Something went wrong while building the valley. Please reload.';
});
