# Shiori Reading Sync — browser extension

Tracks the chapter, scroll percentage and paragraph index on a novel site and
stores them on your self-hosted Shiori sync server. The Android app reads the
same entry, so opening a novel on the phone continues at the browser position
when the server entry is newer.

## Build

```sh
npm run build   # writes dist/chrome and dist/firefox
npm test
```

The PNGs in `src/icons` are the project logo at the sizes declared in both
manifests. Replace them together with the app icon set if the artwork changes.

## Load

**Chrome / Chromium**

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `browser-extension/dist/chrome`.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `browser-extension/dist/firefox/manifest.json`.

The manifest grants access to all HTTP(S) sites because reading sites are
user-configured. If you only read on a few domains, narrow `matches` and
`host_permissions` in both manifests before loading the extension.

## Configure

1. Start the sync server first (see the `shiori-server` repo README). Locally:
   `bun run dev`; production: Cloudflare Workers with D1 (same repo).
2. Open the extension options.
3. **Add server** with the base URL (`https://sync.example.com`, not
   `.../api/v1`) and the token. The token is your data bucket: it must match the
   token configured in the Shiori app tracker so both devices see the same
   progress. If the server runs with `SYNC_TOKENS` set, the token must be on
   that list.
4. **Add site** with the host you read on. Leave the selectors empty for the
   generic heuristics; add them if a site hides chapter text in an unusual
   container.
5. Open a chapter. The popup shows the detected profile and known position.

Built-in NovelUpdates and NovelList profiles are series-page profiles. They
record chapter-link checkpoints while the Shiori app continues to handle those
trackers' chapter-level APIs. Use a custom site profile for exact position sync.

## Behavior

- `scroll_percent` is relative to the identified chapter container, not the
  document, so desktop/mobile font sizes produce comparable values.
- `paragraph_index` is the first paragraph visible near the top of the viewport.
  The app can restore it when percentage alone is ambiguous.
- Every write includes `updated_at = Date.now()`. The server rejects an entry
  that is not strictly newer and returns the winning entry with HTTP `409`.
- The extension only pushes while the position is ahead of the locally known
  entry. Re-reading an earlier paragraph does not move the shared position
  backwards; moving to a later chapter always wins.
- Restoring only happens for the same chapter. If the server is on a later
  chapter, the popup/toast tells you to open that chapter.

## Limitations

- Generic extraction cannot cover every reader. Configure `contentSelector`,
  `titleSelector` and `seriesUrlSelector` for difficult sites.
- Shadow DOM readers and sites that render chapter text inside iframes are not
  supported yet.
- A failed push is retried on the next debounced scroll event; there is no
  persistent offline queue.
- The token is stored in `storage.local`. Export files include it, so keep them
  private.
