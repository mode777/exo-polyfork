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
  `@exo/plugin-sdk` 1.7.0. Update it by re-copying upstream and bumping the
  dependency, never by editing it in place.
- **The manifest is exact.** Unknown fields reject the whole manifest. The
  current contributions are the primary Assets panel, the secondary Parameters
  panel on the right and the Asset Preview content view with `asset-params` as
  its companion; `engines.exo` must stay at or above `0.6.0` while the
  companion association is used.
- **Preview selection stays in one tab.** The panel opens `asset-preview` with
  the fixed instance key `preview`. Later selections travel over
  `local/asset-selected`, and the view's `local/preview-ready` message asks the
  panel to republish its latest selection. Do not create one preview tab per
  asset or pass selection data through the frame URL.
- **Parameters come from Polyfork, never from a GLB.** The preview fetches the
  public `https://polyfork.dev/cdn/{id}-params.json` schema and renders controls
  from it. Edits go to the preview over `local/asset-params-change` and the
  model is rebuilt with `createAsset(params)`. Named `presets` are applied when
  a `colorway`/`faction` choice changes, or the old explicit colours keep
  winning. The preview owns the schema and values;
  `local/asset-params-state` republishes them to a panel that mounts late. Never
  hard-code knobs.
- **The Parameters panel is a declarative companion.** `asset-preview` declares
  `companionPanel: "asset-params"` in the manifest. Exo reveals it when the
  preview opens or is focused and hides it when the last matching content view
  closes. Do not add plugin-side show/hide requests, heartbeats, watchdogs or
  polling; the shell owns this lifecycle. It requires `engines.exo` `>=0.6.0`.
- **The plugin has no workspace access.** It only needs `events:subscribe` for
  theme changes and the plugin-local selection channel. Do not add
  `workspace:read`, `workspace:write` or `workspace:list` for browsing.
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
- `plugin/src/preview-contract.ts` - content-view id, fixed instance key, local
  event topics and the validated selection payload.
- `plugin/src/parameters-contract.ts` - Parameters panel id, the state/change
  local topics and validation for both payloads.
- `plugin/src/asset-module.ts` - the only module loader (`createAsset(params)`)
  and `Object3D` disposal helper, shared by thumbnails and the preview.
- `plugin/src/thumbnails.ts` - hidden WebGL canvas, framing, WebP readback,
  IndexedDB cache (TTL + cap) and in-memory fallback.
- `plugin/src/panel.ts` - DOM, filters, pagination, card selection, opening the
  preview, theme, lifecycle.
- `plugin/src/preview.ts` - Asset Preview content view, orbit camera, parameter
  schema fetch, rebuild-on-edit, hero-image fallback, theme, lifecycle.
- `plugin/src/preview-environment.ts` - procedural sky baked into a PMREM
  environment map, fading shadow-catching ground disc and shadow-casting sun,
  reframed to each asset's bounds.
- `plugin/src/parameters.ts` - right side-bar controls for colour, range,
  choice and toggle knobs, preset-aware choices, pointer-captured slider drags,
  reset and edit publication.
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
continuous slider drag, reusing that tab for a second selection, hiding the
companion when the preview tab closes, the absence of GLB requests, and the
storage mode. Do not replace the shell with a mock: the point is to test the
real contract.

`EXO_SCREENSHOT=1` refreshes the four README screenshots. In CI, the
`e2e-deployed` job points at the published manifest and asserts the same-origin
`data-cache="memory"` path.
