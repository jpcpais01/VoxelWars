# VoxelWars

Destructible voxel warfare in the browser. Two squads of five fight across Pinewater Valley, a forest river valley, and each side tries to destroy the other's energy core.

- **Stack:** Vite + TypeScript + three.js (WebGL2), installable as a PWA via vite-plugin-pwa, deployed to Vercel from `main`.
- **Play:** `npm install && npm run dev`, then open the printed URL.
- **Build:** `npm run build` (typecheck + production bundle in `dist/`).
- **Icons:** `npm run icons` regenerates the PWA icons in `public/`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/world` | Voxel storage, map generator, greedy mesher with AO, chunk manager, destruction and falling bodies |
| `src/render` | Renderer and post pipeline (shadows, DOF, bloom, fog, FXAA, dynamic resolution), voxel and water shaders, particles |
| `src/game` | Match logic, soldiers, weapons and attachments, bot AI, navigation, player controls |
| `src/ui` | HUD, minimap, loadout editor |
| `src/data/patchnotes.ts` | Player-facing patch notes, grouped by hour (UTC), at most 5 entries per group |
