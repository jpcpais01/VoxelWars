import type { Team } from '../core/config';
import type { Difficulty } from '../game/Game';
import type { Loadout } from '../game/weapons';
import type { LightingId } from '../render/Renderer';
import { Link, openLink } from './link';

export interface MatchSettings {
  difficulty: Difficulty;
  minutes: number;
  lighting: LightingId;
}

export interface LobbyPlayer {
  peer: string;
  name: string;
  team: Team;
  host: boolean;
}

/** the host's description of the room, sent whenever it changes */
export interface LobbyInfo {
  code: string;
  phase: 'lobby' | 'match';
  players: LobbyPlayer[];
  settings: MatchSettings;
  isPublic: boolean;
}

export interface RosterEntry {
  id: number;
  name: string;
  team: Team;
  human: boolean;
  loadout: Loadout;
  you: boolean;
}

export interface Welcome {
  you: number;
  roster: (RosterEntry & { alive: boolean; x: number; y: number; z: number; life: number })[];
  settings: MatchSettings;
  time: number;
  timeLeft: number;
  cores: [number, number];
}

/** what the lobby screen needs from either end of a room */
export interface Session {
  readonly role: 'host' | 'peer';
  readonly code: string;
  readonly self: string;
  info: LobbyInfo | null;
  status: string;
  /** milliseconds to the host (peers only) */
  ping: number;
  onChange: () => void;
  onClosed: (reason: string) => void;
  setTeam(team: Team): void;
  setLoadout(l: Loadout): void;
  leave(): void;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(5));
  for (const v of r) s += CODE_CHARS[v % CODE_CHARS.length];
  return s;
}
export const cleanCode = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
export const roomId = (code: string) => `room-${code}`;
const QM_ROOM = 'quickmatch-v1';

export function cleanName(s: string) {
  const n = s.replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || 'Soldier';
}

// ------------------------------------------------------------------------------ quick match
export interface Ad {
  code: string;
  humans: number;
  phase: 'lobby' | 'match';
  host: string;
  t: number;
}

/** a public room's host advertises it in the quick-match room until it is full */
export class Advertiser {
  private link: Link | null = null;
  private timer = 0;
  private closed = false;
  constructor(private ad: () => Ad | null) {
    void openLink(QM_ROOM).then((l) => {
      if (this.closed) return l.leave();
      this.link = l;
      l.onJoin = (peer) => this.send(peer);
      this.timer = window.setInterval(() => this.send(), 3000);
    });
  }
  private send(to?: string) {
    const a = this.ad();
    if (a && this.link) this.link.send('ad', a, to);
  }
  stop() {
    this.closed = true;
    clearInterval(this.timer);
    this.link?.leave();
    this.link = null;
  }
}

/** listens for open public rooms; resolves with the best one, or null when none shows up in time */
export async function findRoom(waitMs: number, onTick: (left: number) => void): Promise<string | null> {
  const link = await openLink(QM_ROOM);
  const ads = new Map<string, Ad>();
  link.on('ad', (a: Ad) => {
    if (a && typeof a.code === 'string' && a.humans < 10) ads.set(a.code, { ...a, t: performance.now() });
  });
  const start = performance.now();
  return new Promise((resolve) => {
    const iv = window.setInterval(() => {
      const el = performance.now() - start;
      onTick(Math.max(0, waitMs - el));
      // join early once something is there and we've heard from the network a little
      const fresh = [...ads.values()].filter((a) => performance.now() - a.t < 8000);
      if (fresh.length && el > 1500) {
        fresh.sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.humans - a.humans);
        finish(fresh[0].code);
      } else if (el > waitMs) finish(null);
    }, 250);
    const finish = (code: string | null) => {
      clearInterval(iv);
      link.leave();
      resolve(code);
    };
  });
}
