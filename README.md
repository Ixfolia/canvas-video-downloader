# Canvas Video Saver

A small Chrome + Firefox (Manifest V3) extension that saves the course videos you
are **already watching** in Canvas LMS (Instructure), for personal offline study.

It does automatically what you would otherwise do by hand in
DevTools → Network: notice the `.mp4` / `.webm` file or the HLS `.m3u8`
playlist the player loads, then let you download it with one click.

Plain JavaScript, no frameworks, **no build step**: load the folder as-is.

> **Acceptable use.** Use this only for courses you are enrolled in, for your own
> offline study. Follow your school's acceptable-use and copyright policies and
> any instructor restrictions. The extension never bypasses DRM, encryption or
> access controls. It only uses URLs your browser is already loading in your
> logged-in session.

---

## File tree

```
canvas-video-downloader/
├── manifest.json          # one manifest for Chrome and Firefox (see "Manifest choice")
├── background.js          # network watcher, per-tab state, badge, MP4/WebM downloads
├── lib/
│   └── common.js          # browser shim, filename sanitiser, HLS parser, MP4 DRM sniffer
├── popup.html / .css / .js   # toolbar popup: list, Download, Copy URL
├── hls.html / hls.js      # HLS downloader page (runs in a tab, see "HLS downloads")
├── options.html / .js     # host restriction, custom domains, "Save as" toggle
├── page.css               # styles for the options and HLS pages
├── icons/icon{16,32,48,128}.png   # generated placeholder icons
├── scripts/
│   ├── package.mjs        # builds per-browser zips into dist/ (optional)
│   └── make-icons.mjs     # regenerates the placeholder icons (no dependencies)
├── tests/common.test.mjs  # unit tests for the parsers and helpers (node --test)
└── package.json           # npm scripts only; there are no dependencies
```

## Install

### Chrome / Edge / Brave (load unpacked)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin **Canvas Video Saver** to the toolbar.

Chrome may list a harmless warning on the extension card about
`background.scripts`. That key is for Firefox, and Chrome ignores it. Use `npm run package` if you want a build
without the warning.

### Firefox 121+ (temporary add-on)
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. If the options page opens with a **Grant site access** button, click it.
   Firefox treats MV3 host permissions as something the user can grant or
   revoke. You can also manage this under `about:addons` → Canvas Video Saver →
   Permissions.

A temporary add-on stays installed until Firefox restarts. To keep it
permanently, sign the Firefox zip (see below) as an *unlisted* add-on on
addons.mozilla.org, which is free and private, and install the signed `.xpi`.

## Usage
1. Open a Canvas page with a video (Canvas Studio, or a Kaltura or Panopto embed) and **press play** for a few seconds.
2. The toolbar badge shows how many videos were detected on that tab.
3. Click the icon. Each entry shows a filename guess, its type (MP4, WebM or HLS), its size when known, and two buttons: **Download** and **Copy URL**.
4. MP4 and WebM files are saved to `Downloads/CanvasVideos/<page title>.mp4`.
   HLS opens a download page in a new tab, with a progress bar.

## Package for both browsers
```bash
npm run package        # or: node scripts/package.mjs
```
This creates:
- `dist/canvas-video-saver-chrome-1.0.0.zip`: upload to the Chrome Web Store, or unzip and load unpacked.
- `dist/canvas-video-saver-firefox-1.0.0.zip`: sign on AMO as unlisted, or use `npx web-ext sign --source-dir dist/firefox`.

Each zip's manifest has the other browser's background key removed, so neither store shows a warning. The script needs Node 18+ and the `zip` command. It has no npm dependencies.

---

## Design notes

### Manifest choice: one manifest with both background keys
```json
"background": { "service_worker": "background.js", "scripts": ["lib/common.js", "background.js"] }
```
- **Chrome** (121+) uses `service_worker` and ignores `scripts` (it only shows a warning).
- **Firefox** (121+) uses `scripts`, which runs as a non-persistent event page, and ignores `service_worker`.

I picked this over separate `manifest.chrome.json` and `manifest.firefox.json` files plus a copy script, for three reasons:
1. The folder loads unpacked in both browsers with no build step.
2. The two manifests can never drift apart.
3. `scripts/package.mjs` still produces clean per-browser manifests for store uploads.

`strict_min_version` is `121.0` because Firefox 121 is the first version that accepts both keys. It also covers `storage.session` (Firefox 115+).

Shared code goes into the service worker through `importScripts('lib/common.js')`, guarded by `typeof importScripts === 'function'`. Firefox lists the same file in `background.scripts` instead, because event pages don't have `importScripts`.

### Cross-browser shim
`lib/common.js` starts with `const api = globalThis.browser ?? globalThis.chrome;`. Every call uses the promise form, which Chrome MV3 supports natively. Message handlers use `return true` + `sendResponse`, which works in both browsers.

### API differences handled
| Area | Chrome | Firefox | What the code does |
|---|---|---|---|
| Background | service worker (ephemeral) | event page (also ephemeral) | State lives in `storage.session` and is re-hydrated on wake. All listeners are registered at top level. |
| `webRequest` blocking | not allowed in MV3 | allowed, but needs `webRequestBlocking` | Listeners are non-blocking only. Nothing is modified. |
| `extraHeaders` option | exists | throws | Not used. `Content-Type`, `Content-Length` and `Content-Range` are visible without it. |
| Request origin fields | `initiator` | `originUrl`, `documentUrl` | Both are checked. |
| `downloads.download` | rejects unknown keys | supports `incognito` and `cookieStoreId` | Firefox-only options are added only on Firefox: private-window and container downloads use the matching cookie jar. |
| `chrome.offscreen` | exists | doesn't exist | Not used. HLS runs in an extension tab instead (next section). |
| Host permissions | granted at install | can be withheld by the user | The popup and options page show a **Grant** button that calls `permissions.request`. |
| `storage.session` | 102+ | 115+ | Falls back to `storage.local`, pruned on startup. |

### HLS downloads: why an extension tab and not an offscreen document
An HLS video is hundreds of small segments, and saving one can take minutes. That rules out the usual places to run long work:
- The Chrome **service worker** can be killed while idle. It also can't call `URL.createObjectURL`, which is needed to hand a Blob to `downloads.download`.
- **`chrome.offscreen`** is Chrome-only, and an offscreen document can't call `chrome.downloads` itself.
- The **popup** closes as soon as it loses focus.

A normal extension tab (`hls.html`) behaves the same in both browsers. It stays alive while open, shows progress with a Cancel button, and saves the joined Blob directly. It:
1. Parses the master playlist and lets you pick a quality (best by default).
2. **Refuses encrypted streams**: any `#EXT-X-KEY` or `#EXT-X-SESSION-KEY` whose METHOD is not `NONE` (AES-128, SAMPLE-AES, FairPlay, Widevine and so on). No keys are fetched and nothing is decrypted.
3. Refuses live streams, meaning playlists with no `#EXT-X-ENDLIST`.
4. Fetches segments 4 at a time with retries, keeps them in playlist order, and supports `#EXT-X-BYTERANGE`.
5. Saves `.ts` for MPEG-TS streams. For fMP4/CMAF streams it saves `.mp4` (init segment + fragments = a valid fragmented MP4).
6. If the audio is a separate rendition, saves it as a second file and shows the `ffmpeg -c copy` command to merge the two.

### Range requests
Players fetch MP4s in `206 Partial Content` chunks. The total size is read from `Content-Range: bytes X-Y/TOTAL`, and all chunks collapse into one entry, keyed by origin + path, keeping the freshest signed query string. The download passes the bare URL to the downloads API. That API sends a normal request with no `Range` header, so you get the whole file, not a fragment.

### Expired links and DRM
- Before an MP4 download starts, the background script fetches the first 256 KB of the file (a Range "probe"). The probe checks three things:
  - **Expired link:** a 401, 403 or 410 response shows the expired-link message ("replay the video to capture a fresh link"). A **Try anyway** link is offered, in case the server only refuses the probe.
  - **Size:** the full size is read from `Content-Range`.
  - **DRM:** if the file's `moov` box contains `encv`, `enca`, `sinf` or `pssh`, the file uses Common Encryption (DRM) and the download is refused.
- Downloads that fail later with `SERVER_FORBIDDEN`, `SERVER_UNAUTHORIZED` or `SERVER_BAD_CONTENT` are shown in the popup as expired.
- If a page makes a request that looks like a DRM license request (Widevine, PlayReady, FairPlay, Kaltura uDRM and similar), the whole tab is marked as DRM and downloads are disabled.

## Permissions
| Permission | Why it is needed |
|---|---|
| `webRequest` | To read the **response headers** (`Content-Type`, `Content-Range`, `Content-Length`) of requests the page already makes. That is how videos are detected. Listeners are non-blocking and never change a request. |
| `downloads` | To save the file to `Downloads/CanvasVideos/` using the browser's own download manager and your existing session cookies. |
| `storage` | `storage.session` keeps per-tab detections across service-worker restarts. `storage.local` keeps your options. |
| `host_permissions: <all_urls>` | `webRequest` only reports requests to hosts the extension has permission for. Video files come from many CDNs: Instructure media, Kaltura, Panopto, CloudFront, your school's own domain. The same permission also lets the probe and HLS fetches use your session, and makes tab titles available for filenames. |

**Why not `tabs` or `activeTab`?** Host permissions already expose the URL and title of matching tabs, and `tabs.query`, `tabs.create` and `tabs.onRemoved` need no permission. `activeTab` only grants access after a click, but detection has to happen while the video plays, before you open the popup. Leaving both out keeps the install prompt shorter.

### Restrict to Canvas (options page)
Under **Options → Which pages to watch → Only Canvas pages**, the extension ignores every tab whose page is not on `*.instructure.com` or one of your custom domains (for example `canvas.myschool.edu`).

The check uses the **tab's page address**, not the video host, so embedded Kaltura or Panopto players on a course page still work. The `<all_urls>` permission is still required, because the video CDNs can't be listed in advance.

## Privacy
- No analytics, telemetry, remote code or external servers.
- The only network requests the extension makes are to the video URLs the page already loaded: the HLS playlist and segment fetches, and the 256 KB probe.
- No credentials are stored. Downloads use the browser's own cookies.

## Known limitations
- **Encrypted streams are never downloaded.** That covers DRM (Widevine, FairPlay, PlayReady) and HLS AES-128 or SAMPLE-AES. This is deliberate.
- **DASH (`.mpd`) and YouTube** are not supported. YouTube streams are split audio and video range parts, and downloading them is against YouTube's terms.
- **HLS** is saved as `.ts` for MPEG-TS streams, which VLC plays. Convert losslessly with `ffmpeg -i in.ts -c copy out.mp4`. Segments are held in memory until saved, so very long high-bitrate streams (several GB) need a lot of RAM. Streams that switch init segments mid-playlist may not join cleanly.
- Signed URLs expire, often within minutes or hours. Replay the video to capture a fresh link.
- Detection only sees requests made **after** the extension was installed or enabled. Reload pages that were already open.
- Media served by a page's own service worker, or from the back/forward cache, may not show up. Reload the page.
- In Chrome **incognito**, the extension must be allowed in incognito. Downloads then use the normal profile's cookies, so cookie-protected media may fail. Firefox private windows are handled through the `incognito` download option.
- Very rarely, a non-video request with a video Content-Type, or a DASH-style segment URL, can be listed. Ignore it, or press **Clear list**.

## Troubleshooting
- **The popup is a tiny blank white box, or nothing is detected.** Check that the folder you loaded keeps the layout shown in the file tree, with `lib/common.js` and `icons/` as subfolders next to `manifest.json`. Firefox shows a blank box when it can't load `popup.html`.
- **Options → Diagnostics** shows whether site access is granted and whether the background script responds. It also lists every video-like request the extension saw, with why it was listed or ignored. **Copy report** copies that as text. URLs appear without their query strings.
- **Options → Diagnostics → Open list** shows a tab's videos in a normal tab. Use it if the toolbar popup won't display.
- To see errors in Firefox, open `about:debugging` → **Inspect** → Console. In Chrome, open `chrome://extensions` → **service worker**.

## Development
```bash
npm test               # unit tests (Node 18+): filenames, keys, HLS parser, MP4 DRM sniffing
npm run package        # build dist/ zips
npm run icons          # regenerate icons
```

## Manual test checklist
- [ ] **Canvas Studio MP4**: open a Canvas Studio video page and press play.
  - The badge shows `1`.
  - The popup shows **MP4**, the size and "streamed".
  - **Download** saves `CanvasVideos/<Page title>.mp4`, and the size matches the total from `Content-Range`, not one chunk.
  - **Copy URL** copies the URL.
- [ ] **Embedded Kaltura or Panopto**: on a course page with an embedded player, press play.
  - The video is listed on the course tab, with the iframe host shown before the media host.
  - The download works.
  - The badge does not count individual `.ts` or `.m4s` segments.
- [ ] **HLS stream**: play a Panopto or Kaltura HLS video.
  - One **HLS** entry appears, even though the player loads a master playlist plus variant playlists.
  - **Download** opens the HLS page. Pick a quality and press **Start**.
  - The progress bar runs to completion and the `.ts` or `.mp4` file plays in VLC.
- [ ] **Expired URL**: detect a video, wait until its signed link expires (or sign out of Canvas in another tab), then click **Download**.
  - The red "link has expired… replay the video" message appears.
  - Replay the video. The entry updates with the fresh URL, and **Download** works.
- [ ] **DRM-protected video**: open a page whose player uses Widevine or FairPlay, or an AES-encrypted HLS stream.
  - A red DRM banner and/or a **DRM** tag appears, and **Download** is disabled.
  - The HLS page says the stream is encrypted and refuses it.
- [ ] Navigate to another page in the same tab: the list and badge reset. Close the tab: its state is removed.
- [ ] Restricted mode with a non-Canvas site: nothing is detected, and the popup shows the restricted-mode notice.

## License
MIT. Personal project, not affiliated with Instructure, Kaltura or Panopto.
