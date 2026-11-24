# AGENTS.md

`exo-polyfork` is a Polyfork asset browser panel for the Exo editor. This file
records the constraints that are easy to break accidentally.

## Hard rules

- **No branches and always push to main.** Work directly on `main`; do not create
  feature branches. When the work is complete, commit it and push to `main`,
  which triggers the Pages deployment workflow.
- **No hand-written protocol.** Both pages use `connectBrowserPlugin()` from the
  vendored SDK. Never add a raw `postMessage`, envelope, handshake or reply.
- **Never fetch a GLB.** Assets are created from the parametric
  `https://polyfork.dev/cdn/{id}.mjs` module with `createAsset()`. The preview
  and regular `.glb` endpoints are forbidden, including for thumbnails.
- **The SDK stays unmodified.** `sdk/` is a vendored copy of
  `@exo/plugin-sdk` 1.8.0. Update it by re-copying upstream and bumping the
  dependency, never by editing it in place.
- **Styling follows the shell theme.** Each entry imports
  `@exo/plugin-sdk/theme.css` before its local sheets and calls `followTheme()`;
  component CSS consumes the semantic `--exo-*` tokens. Do not add a second
  palette, raw component colours or `prefers-color-scheme` overrides after the
  handshake. Keep focus rings on `--exo-focus`, selection on the selection
  tokens, native scrollbars/controls on `color-scheme`, and honour
  `prefers-reduced-motion`.
- **The manifest is exact.** Unknown fields reject the whole manifest. The
  current contributions are the primary Assets panel, the secondary Parameters
  panel on the right and the Asset Preview content view with `asset-params` as
  its companion; `engines.exo` must stay at or above `0.8.3` while the
  multi-instance preview and active-tab companion behavior is used.
- **Every asset gets its own preview tab.** The panel opens `asset-preview` with
  a stable, hashed per-asset instance key and the initial selection as the
  content-view payload. Selecting an already-open asset focuses its existing
  tab; selecting a different asset opens another tab. Do not pass selection
  data through the frame URL or reopen a fixed `preview` instance.
- **Exports are generated, then saved by the shell.** The preview header's GLB
  button rebuilds the model from the current parameters and serializes it with
  three.js `GLTFExporter`; the JSON button writes the parameter values plus the
  exact `https://polyfork.dev/cdn/{id}.mjs` generator URL. Both use
  `requestNewFile()` so Exo owns the Save As dialog, the path and the create-only
  write. Never fetch a Polyfork GLB, never trigger a browser download, and never
  write a workspace file directly.
- **Parameters come from Polyfork, never from a GLB.** The preview fetches the
  public `https://polyfork.dev/cdn/{id}-params.json` schema and renders controls
  from it. Edits go to the preview over `local/asset-params-change` and the
  model is rebuilt with `createAsset(params)`. Named `presets` are applied when
  a `colorway`/`faction` choice changes, or the old explicit colours keep
  winning. The preview owns the schema and values;
  `local/asset-params-state` republishes them to a panel that mounts late. Never
  hard-code knobs.
- **The Parameters panel follows the active preview tab.** `asset-preview`
  declares `companionPanel: "asset-params"` in the manifest. Exo reveals it when
  a preview tab opens or becomes active, and hides it when the active tab is not
  a preview or the last preview closes. Each preview publishes its own instance
  id and visibility over the `local/asset-params-*` channel only so the shared
  panel can show the visible preview's schema and values. Do not add plugin-side
  show/hide requests, heartbeats, watchdogs, interval polling or shell-DOM
  access; the shell owns the companion lifecycle. Multi-instance tab switching
  and active-tab hiding require `engines.exo` `>=0.8.3`.
- **Workspace access is only the shell-owned export write.** The plugin declares
  `events:subscribe` for theme changes and the plugin-local channels, plus
  `workspace:read`/`workspace:write` (the shell requires both) solely so the
  preview header can call `requestNewFile()` and let Exo show its Save As dialog.
  The plugin never calls a read method, never chooses a path and never writes
  directly; do not add `workspace:list` or browse the workspace.
- **No shell DOM.** The panel runs in its own iframe and owns only its document.
- **No asset redistribution.** Link to Polyfork's CDN. Do not vendor, mirror or
  commit Polyfork asset files or the catalogue.
- **Keep storage best-effort.** The deployed plugin is same-origin with the
  shell, so Exo runs it in an opaque sandbox without IndexedDB. The in-memory
  cache fallback in `thumbnails.ts` is required; never assume persistent
  storage.

## Architecture

- `plugin/src/api.ts` - REST client, exact-id detection, response validation.
  The catalogue's `q` search does not index ids; full ids use the detail endpoint.
- `plugin/src/preview-contract.ts` - content-view id, per-asset instance-key
  hashing and the validated selection payload.
- `plugin/src/parameters-contract.ts` - Parameters panel id, the state/change
  local topics, instance ids, visibility flags and validation for both payloads.
- `plugin/src/asset-module.ts` - the only module loader (`createAsset(params)`)
  and `Object3D` disposal helper, shared by thumbnails and the preview.
- `plugin/src/thumbnails.ts` - hidden WebGL canvas, framing, WebP readback,
  IndexedDB cache (TTL + cap) and in-memory fallback.
- `plugin/src/panel.ts` - DOM, filters, pagination, card selection, opening one
  per-asset preview tab, shell theme via `followTheme`, lifecycle.
- `plugin/src/preview.ts` - per-asset Asset Preview content view, orbit camera,
  parameter schema fetch, instance id and tab visibility publication,
  rebuild-on-edit, GLB export, hero-image fallback, shell theme via
  `followTheme`, lifecycle.
- `plugin/src/exports.ts` - the replayable JSON config payload (generator module
  URL plus parameter values) and safe export filenames.
- `plugin/src/preview-environment.ts` - procedural sky baked into a PMREM
  environment map, fading shadow-catching ground disc and shadow-casting sun,
  reframed to each asset's bounds.
- `plugin/src/parameters.ts` - right side-bar controls for colour, range,
  choice and toggle knobs, per-instance state cache, active-preview selection,
  pointer-captured slider drags, reset, edit publication and panel hide when no
  preview tab is visible.
- `plugin/src/controller.ts` - register-mode handshake, panel and content-view
  registration.

The list always requests `free=1&per_page=20`. Page changes abort the previous
request and cancel queued thumbnail renders; active renders still warm the
cache.

## Verification

```bash
npm run typecheck --workspace plugin
npm test --workspace plugin
npm run build --workspace plugin
npm test --workspace e2e
```

The Playwright suite uses the **deployed** Exo shell, not a local copy. It serves
the local `plugin/dist` at a fake cross-origin origin through request
interception and uses the in-memory File System Access shim in `e2e/fake-fsa.js`.
It verifies consent, the activity-bar item, 20-per-page pagination, name /
category / kit filters, exact-id lookup, the module-rendered thumbnail, opening
the Asset Preview content view and its automatic right side-bar Parameters
companion from a card, a preset/colourway edit that rebuilds the model, a
continuous slider drag, JSON and GLB exports through the shell's Save As dialog,
opening a second per-asset preview tab, the Parameters panel following the
active preview and hiding on a non-preview tab, closing one preview without
disturbing the other, hiding the companion when the last preview closes, the
absence of GLB requests, and the storage mode. Do not replace the shell with a
mock: the point is to test the real contract.

`EXO_SCREENSHOT=1` refreshes the four README screenshots. In CI, the
`e2e-deployed` job points at the published manifest and asserts the same-origin
`data-cache="memory"` path.
