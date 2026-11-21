# AGENTS.md

`exo-polyfork` is a Polyfork asset browser panel for the Exo editor. This file
records the constraints that are easy to break accidentally.

## Hard rules

- **No hand-written protocol.** Both pages use `connectBrowserPlugin()` from the
  vendored SDK. Never add a raw `postMessage`, envelope, handshake or reply.
- **Never fetch a GLB.** Assets are created from the parametric
  `https://polyfork.dev/cdn/{id}.mjs` module with `createAsset()`. The preview
  and regular `.glb` endpoints are forbidden, including for thumbnails.
- **The SDK stays unmodified.** `sdk/` is a vendored copy of
  `@exo/plugin-sdk` 1.7.0. Update it by re-copying upstream and bumping the
  dependency, never by editing it in place.
- **The manifest is exact.** Unknown fields reject the whole manifest. The
  current contribution is one primary panel; `engines.exo` must stay at or above
  `0.3.0` while panels are contributed.
- **The plugin has no workspace access.** It only needs `events:subscribe` for
  theme changes. Do not add `workspace:read`, `workspace:write` or
  `workspace:list` for browsing.
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
- `plugin/src/thumbnails.ts` - hidden WebGL canvas, module import, framing,
  WebP readback, IndexedDB cache (TTL + cap) and in-memory fallback.
- `plugin/src/panel.ts` - DOM, filters, pagination, theme, lifecycle.
- `plugin/src/controller.ts` - register-mode handshake and panel registration.

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
category / kit filters, exact-id lookup, the module-rendered thumbnail, the
absence of GLB requests, and the storage mode. Do not replace the shell with a
mock: the point is to test the real contract.

`EXO_SCREENSHOT=1` refreshes the two README screenshots. In CI, the
`e2e-deployed` job points at the published manifest and asserts the same-origin
`data-cache="memory"` path.
