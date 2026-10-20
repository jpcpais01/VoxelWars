/// <reference lib="webworker" />
// Renders the sound bank off the main thread, most needed sounds first, and hands each one back as transferables.
import { renderSound, soundDefs } from './sounds';

const defs = soundDefs();

self.onmessage = (e: MessageEvent<{ keys: string[]; rate: number }>) => {
  for (const key of e.data.keys) {
    const def = defs.get(key);
    if (!def) continue;
    const out = renderSound(key, def, e.data.rate);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ key, ...out }, out.variants.flat().map((c) => c.buffer as ArrayBuffer));
  }
};
