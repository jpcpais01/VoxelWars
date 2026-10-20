import type { JsonValue, Room } from '@trystero-p2p/core';

/**
 * A room of peers over WebRTC. Peers find each other through Trystero's public signaling
 * (Nostr relays, no account or server of ours), then talk directly. Two kinds of traffic:
 * reliable ordered messages (events, edits) and a fast unordered, unreliable channel for
 * snapshots and movement, where a late packet is worth less than the next one.
 */
export interface Link {
  readonly self: string;
  readonly peers: Set<string>;
  onJoin: (peer: string) => void;
  onLeave: (peer: string) => void;
  send(kind: string, data: unknown, to?: string | string[]): void;
  sendBin(kind: string, data: Uint8Array, to?: string | string[]): void;
  sendFast(data: Uint8Array, to?: string): void;
  on(kind: string, cb: (data: any, from: string) => void): void;
  onBin(kind: string, cb: (data: ArrayBuffer, from: string) => void): void;
  onFast: (data: ArrayBuffer, from: string) => void;
  leave(): void;
}

export const APP_ID = 'voxelwars-pwa-online-1';
/** negotiated id of our extra, unreliable data channel (Trystero's own channel takes 0 or 1) */
const FAST_ID = 77;

/** `?relay=wss://…` swaps public Nostr signaling for a self-hosted Trystero WebSocket relay (read once, at load) */
const RELAY = (() => {
  try {
    return new URLSearchParams(location.search).get('relay');
  } catch {
    return null;
  }
})();

/** query parameters that should survive the page's own URL changes */
export function keepParams() {
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of ['relay', 'debug']) {
    const v = q.get(k);
    if (v !== null) out.set(k, v);
  }
  if (RELAY && !out.has('relay')) out.set('relay', RELAY);
  const s = out.toString().replace(/=(&|$)/g, '$1');
  return s ? `&${s}` : '';
}

export async function openLink(roomId: string): Promise<Link> {
  const relay = RELAY;
  let room: Room;
  let self: string;
  if (relay) {
    const m = await import('@trystero-p2p/ws-relay');
    room = m.joinRoom({ appId: APP_ID, relayConfig: { urls: [relay] } }, roomId);
    self = m.selfId;
  } else {
    const m = await import('trystero');
    room = m.joinRoom({ appId: APP_ID, relayConfig: { warnOnRelayFailure: false } }, roomId);
    self = m.selfId;
  }
  const json = room.makeAction<{ k: string; d: JsonValue }>('vwj');
  const bin = room.makeAction<Uint8Array>('vwb');
  const handlers = new Map<string, (data: any, from: string) => void>();
  const binHandlers = new Map<string, (data: ArrayBuffer, from: string) => void>();
  const fast = new Map<string, RTCDataChannel>();
  const peers = new Set<string>();

  const link: Link = {
    self,
    peers,
    onJoin: () => {},
    onLeave: () => {},
    onFast: () => {},
    send(kind, data, to) {
      void json.send({ k: kind, d: data as JsonValue }, to ? { target: to } : undefined).catch(() => {});
    },
    sendBin(kind, data, to) {
      void bin.send(data, { target: to ?? null, metadata: kind }).catch(() => {});
    },
    sendFast(data, to) {
      const targets = to ? [to] : [...peers];
      for (const p of targets) {
        const ch = fast.get(p);
        if (ch && ch.readyState === 'open' && ch.bufferedAmount < 1 << 16) {
          try {
            ch.send(data as Uint8Array<ArrayBuffer>);
            continue;
          } catch {
            /* fall through to the reliable path */
          }
        }
        link.sendBin('fast', data, p);
      }
    },
    on(kind, cb) {
      handlers.set(kind, cb);
    },
    onBin(kind, cb) {
      binHandlers.set(kind, cb);
    },
    leave() {
      for (const ch of fast.values()) ch.close();
      fast.clear();
      peers.clear();
      void room.leave();
    },
  };

  json.onMessage = (msg, { peerId }) => {
    if (msg && typeof msg.k === 'string') handlers.get(msg.k)?.(msg.d, peerId);
  };
  bin.onMessage = (data, { peerId, metadata }) => {
    const kind = typeof metadata === 'string' ? metadata : '';
    // binary can arrive as a view into a larger buffer: hand on an exact, aligned copy
    const raw = data as unknown;
    const buf = ArrayBuffer.isView(raw) ? (raw.buffer as ArrayBuffer).slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : (raw as ArrayBuffer);
    if (kind === 'fast') link.onFast(buf, peerId);
    else binHandlers.get(kind)?.(buf, peerId);
  };
  room.onPeerJoin = (peer) => {
    peers.add(peer);
    // both ends open the same pre-agreed channel, so no renegotiation is needed
    const pc = room.getPeers()[peer];
    if (pc) {
      try {
        const ch = pc.createDataChannel('vwfast', { negotiated: true, id: FAST_ID, ordered: false, maxRetransmits: 0 });
        ch.binaryType = 'arraybuffer';
        ch.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) link.onFast(e.data, peer);
        };
        fast.set(peer, ch);
      } catch {
        /* the reliable channel carries it instead */
      }
    }
    link.onJoin(peer);
  };
  room.onPeerLeave = (peer) => {
    peers.delete(peer);
    fast.get(peer)?.close();
    fast.delete(peer);
    link.onLeave(peer);
  };
  return link;
}
