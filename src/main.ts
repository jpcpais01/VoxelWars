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

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------------------------ settings
interface Settings {
  quality: Quality | 'auto';
  volume: number;
  zoom: number;
  fps: boolean;
  difficulty: Difficulty;
  lighting: LightingId;
  minutes: number;
}
const SETTINGS_KEY = 'voxelwars.settings.v1';
const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function loadSettings(): Settings {
  const def: Settings = { quality: 'auto', volume: 0.8, zoom: 1, fps: false, difficulty: 'regular', lighting: 'morning', minutes: 15 };
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
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { vw: { game, renderer, world } });
  await progress(1, 'Ready');
  clearInterval(tipTimer);
  $('loading').classList.add('hidden');
  state = 'menu';
  $('menu').classList.remove('hidden');
  renderMenuKit();
  renderCareer();
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
  syncPauseOverlay();
}
editor.onClose = (l) => {
  renderMenuKit();
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
$('e-menu').addEventListener('click', () => location.reload());

function setPaused(p: boolean) {
  if (state !== 'playing' || game.over) return;
  paused = p;
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
  renderer.shadowForce = true;
  game.start('You', JSON.parse(JSON.stringify(editor.loadout)), { difficulty: settings.difficulty, minutes: settings.minutes });
  hud = new HUD(game);
  applySettings();
  refreshInputEnabled();
  hud.message('Destroy the red core. Protect yours.', 'info');
}

function showEnd(winner: Team) {
  const win = winner === TEAM_BLUE;
  const p = game.player;
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
