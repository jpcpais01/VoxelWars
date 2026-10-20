import { Team } from '../core/config';
import type { Loadout } from '../game/weapons';
import { HostSession } from '../net/host';
import { keepParams, openLink } from '../net/link';
import { PeerSession } from '../net/peer';
import { MatchSettings, Welcome, cleanCode, cleanName, findRoom, newCode, roomId } from '../net/session';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NAME_KEY = 'voxelwars.name.v1';
const DIFF_LABEL: Record<string, string> = { recruit: 'Recruit', regular: 'Regular', veteran: 'Veteran' };

export interface OnlineHooks {
  loadout(): Loadout;
  settings(): MatchSettings;
  saveSettings(s: MatchSettings): void;
  hostStart(s: HostSession): void;
  peerWelcome(s: PeerSession, w: Welcome): void;
  peerReady(s: PeerSession): void;
  openLoadout(): void;
  click(): void;
  shown(open: boolean): void;
  /** the session ended while a match was running */
  lost(reason: string): void;
}

/** the Play online panel: quick match, rooms by code or link, and the team lobby */
export class OnlineUI {
  session: HostSession | PeerSession | null = null;
  inMatch = false;
  private busy = false;
  private panel = $('online');
  private view = this.panel.querySelector('.on-panel') as HTMLElement;
  private nameEl = $<HTMLInputElement>('on-name');
  private codeEl = $<HTMLInputElement>('on-code');

  constructor(private hooks: OnlineHooks) {
    let saved = '';
    try {
      saved = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* ignore */
    }
    this.nameEl.value = saved;
    this.nameEl.addEventListener('change', () => this.saveName());
    this.codeEl.addEventListener('input', () => (this.codeEl.value = cleanCode(this.codeEl.value)));
    this.codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('on-join').click();
    });
    $('on-close').addEventListener('click', () => this.hide());
    $('on-quick').addEventListener('click', () => this.quick());
    $('on-create').addEventListener('click', () => this.host(newCode(), false));
    $('on-join').addEventListener('click', () => {
      const code = cleanCode(this.codeEl.value);
      if (code.length < 4) return this.status('Enter the room code your friend sent you.', 'bad');
      this.join(code);
    });
    $('lb-leave').addEventListener('click', () => {
      this.hooks.click();
      this.leave();
    });
    $('lb-copy').addEventListener('click', () => this.copy());
    $('lb-loadout').addEventListener('click', () => this.hooks.openLoadout());
    $('lb-go').addEventListener('click', () => this.go());
    this.panel.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) =>
      b.addEventListener('click', () => {
        this.hooks.click();
        this.session?.setTeam(+b.dataset.team! as Team);
      }),
    );
    const seg = (id: string, apply: (s: MatchSettings, v: string) => void) =>
      $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          const s = this.session;
          if (!(s instanceof HostSession)) return;
          this.hooks.click();
          const next = { ...s.info.settings };
          apply(next, b.dataset.v!);
          s.setSettings(next);
          this.hooks.saveSettings(next);
        }),
      );
    seg('lb-diff', (s, v) => (s.difficulty = v as MatchSettings['difficulty']));
    seg('lb-tod', (s, v) => (s.lighting = v as MatchSettings['lighting']));
    seg('lb-len', (s, v) => (s.minutes = +v));
  }

  get isOpen() {
    return this.panel.classList.contains('open');
  }

  show() {
    this.hooks.click();
    this.panel.classList.add('open');
    this.hooks.shown(true);
    this.render();
  }

  hide() {
    this.hooks.click();
    this.panel.classList.remove('open');
    this.hooks.shown(false);
  }

  private get name() {
    return cleanName(this.nameEl.value || 'Soldier');
  }

  private saveName() {
    this.nameEl.value = cleanName(this.nameEl.value || '');
    try {
      localStorage.setItem(NAME_KEY, this.nameEl.value);
    } catch {
      /* ignore */
    }
  }

  private status(text: string, kind: '' | 'busy' | 'bad' = '') {
    const el = this.session ? $('lb-status') : $('on-status');
    el.textContent = text;
    el.className = `on-status ${kind}`;
  }

  private lock(on: boolean) {
    this.busy = on;
    for (const id of ['on-quick', 'on-create', 'on-join']) ($(id) as HTMLButtonElement).disabled = on;
  }

  async quick() {
    if (this.busy) return;
    this.hooks.click();
    this.saveName();
    this.lock(true);
    this.status('Looking for an open squad…', 'busy');
    let code: string | null = null;
    try {
      code = await findRoom(9000, (left) => this.status(`Looking for an open squad… ${Math.ceil(left / 1000)}s`, 'busy'));
    } catch {
      this.lock(false);
      return this.status('Could not reach the matchmaking network. Check your connection and try again.', 'bad');
    }
    this.lock(false);
    if (code) this.join(code);
    else this.host(newCode(), true, 'No open squads right now, so you opened one. Players using Quick match will land here.');
  }

  async host(code: string, isPublic: boolean, note?: string) {
    if (this.busy && !note) return;
    this.hooks.click();
    this.saveName();
    this.lock(true);
    this.status('Opening a room…', 'busy');
    try {
      const link = await openLink(roomId(code));
      const s = new HostSession(link, code, this.name, this.hooks.settings(), isPublic);
      this.attach(s);
      history.replaceState(null, '', `${location.pathname}?host=${code}${isPublic ? '&pub=1' : ''}${keepParams()}`);
      this.status(note ?? (isPublic ? 'Open to Quick match. Share the code or link to bring friends.' : 'Share the code or invite link with your friends.'));
    } catch {
      this.status('Could not open a room. Check your connection and try again.', 'bad');
    }
    this.lock(false);
  }

  async join(code: string) {
    this.hooks.click();
    this.saveName();
    this.lock(true);
    this.status(`Looking for room ${code}…`, 'busy');
    try {
      const link = await openLink(roomId(code));
      const s = new PeerSession(link, code, this.name, this.hooks.loadout());
      s.onWelcome = (w) => this.hooks.peerWelcome(s, w);
      s.onReady = () => {
        this.inMatch = true;
        this.hooks.peerReady(s);
      };
      s.onRematch = () => {
        location.href = `${location.pathname}?room=${code}${keepParams()}`;
      };
      this.attach(s);
      history.replaceState(null, '', `${location.pathname}?room=${code}${keepParams()}`);
    } catch {
      this.status('Could not reach the network. Check your connection and try again.', 'bad');
    }
    this.lock(false);
  }

  private attach(s: HostSession | PeerSession) {
    this.session = s;
    s.onChange = () => this.render();
    s.onClosed = (reason) => {
      if (this.inMatch) return this.hooks.lost(reason);
      this.session = null;
      history.replaceState(null, '', `${location.pathname}${keepParams().replace('&', '?')}`);
      this.render();
      this.status(reason, 'bad');
    };
    this.render();
  }

  leave() {
    this.session?.leave();
    this.session = null;
    this.inMatch = false;
    history.replaceState(null, '', `${location.pathname}${keepParams().replace('&', '?')}`);
    this.render();
    this.status('');
  }

  private copy() {
    const s = this.session;
    if (!s) return;
    this.hooks.click();
    const url = `${location.origin}${location.pathname}?room=${s.code}`;
    const btn = $('lb-copy');
    const done = (ok: boolean) => {
      btn.textContent = ok ? 'Link copied' : url;
      setTimeout(() => (btn.textContent = 'Copy invite link'), 1800);
    };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.clipboard?.writeText) nav.clipboard.writeText(url).then(() => done(true), () => done(false));
    else done(false);
  }

  private go() {
    const s = this.session;
    if (!s) return;
    if (s instanceof HostSession) {
      if (s.info.phase === 'lobby') this.hooks.hostStart(s);
    } else if (s.info?.phase === 'match') {
      this.status('Deploying…', 'busy');
      s.deploy();
    }
  }

  /** the kit changed in the editor */
  loadoutChanged(l: Loadout) {
    this.session?.setLoadout(l);
  }

  render() {
    const s = this.session;
    this.view.classList.toggle('lobby', !!s);
    if (!s) return;
    $('lb-code').textContent = s.code;
    const info = s.info;
    const isHost = s instanceof HostSession;
    if (!info) {
      $('lb-status').textContent = s.status;
      $('lb-status').className = 'on-status busy';
      for (const t of [0, 1]) $(`lb-team${t}`).innerHTML = '';
      ($('lb-go') as HTMLButtonElement).disabled = true;
      $('lb-go').querySelector('span')!.textContent = 'Connecting';
      $('lb-go-sub').textContent = '';
      return;
    }
    if (!isHost && $('lb-status').classList.contains('busy') && info) {
      $('lb-status').className = 'on-status';
      $('lb-status').textContent = info.phase === 'match' ? 'Match in progress. Pick a side and jump in.' : `Waiting for ${info.players.find((p) => p.host)?.name ?? 'the host'} to deploy the squad.`;
    }
    const me = info.players.find((p) => p.peer === s.self);
    for (const t of [0, 1] as Team[]) {
      const list = info.players.filter((p) => p.team === t).sort((a, b) => +b.host - +a.host);
      const rows = list.map(
        (p) => `<div class="slot ${p.peer === s.self ? 'me' : ''}"><span class="av">${esc(p.name.slice(0, 1).toUpperCase())}</span><b>${esc(p.name)}</b>${p.host ? '<em class="host">HOST</em>' : ''}${p.peer === s.self ? '<em>YOU</em>' : ''}</div>`,
      );
      for (let i = list.length; i < 5; i++) rows.push(`<div class="slot bot" style="animation-delay:${i * 0.03}s"><span class="av">⚙</span><span>Bot</span></div>`);
      $(`lb-team${t}`).innerHTML = rows.join('');
      $(`lb-n${t}`).textContent = `${list.length} ${list.length === 1 ? 'player' : 'players'} · ${5 - list.length} bots`;
      const btn = this.panel.querySelector<HTMLButtonElement>(`[data-team="${t}"]`)!;
      btn.disabled = !me || me.team === t || list.length >= 5 || (isHost && info.phase !== 'lobby') || (!isHost && this.inMatch);
      btn.textContent = me?.team === t ? 'Your team' : `Join ${t === 0 ? 'Blue' : 'Red'}`;
    }
    // settings: the host picks, everyone sees
    const set = (id: string, v: string) => $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    set('lb-diff', info.settings.difficulty);
    set('lb-tod', info.settings.lighting);
    set('lb-len', String(info.settings.minutes));
    $('lb-setup').classList.toggle('ro', !isHost || info.phase !== 'lobby');
    const go = $<HTMLButtonElement>('lb-go');
    const label = go.querySelector('span')!;
    const n = info.players.length;
    const sub = `${n} ${n === 1 ? 'player' : 'players'} · ${10 - n} bots · ${DIFF_LABEL[info.settings.difficulty]} · ${info.settings.minutes} min`;
    if (isHost) {
      go.disabled = info.phase !== 'lobby';
      label.textContent = 'Deploy squad';
      $('lb-go-sub').textContent = sub;
    } else if (info.phase === 'match') {
      go.disabled = this.inMatch;
      label.textContent = 'Deploy into match';
      $('lb-go-sub').textContent = 'Match in progress · a bot steps aside for you';
    } else {
      go.disabled = true;
      label.textContent = 'Waiting for host';
      $('lb-go-sub').textContent = sub;
    }
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
