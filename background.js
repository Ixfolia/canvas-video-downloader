/*
 * Canvas Video Saver - background script.
 *
 * Runs as a service worker in Chrome and as a (non-persistent) event page in
 * Firefox. It passively watches network responses, remembers which video
 * files / HLS playlists each tab has loaded, keeps the toolbar badge up to
 * date and performs MP4/WebM downloads via the downloads API.
 *
 * SERVICE WORKER LIFECYCLE (Chrome) / EVENT PAGE LIFECYCLE (Firefox)
 * ------------------------------------------------------------------
 * The browser can terminate this script after ~30 s of inactivity and start
 * it again for the next event. Consequences:
 *   1. All listeners are registered synchronously at top level, so the
 *      browser knows to wake us for those events.
 *   2. Global variables are only a cache. The source of truth is
 *      storage.session (or storage.local as a fallback). On every wake we
 *      lazily re-hydrate the cache before handling the first event.
 *   3. No long-running work happens here. Big HLS downloads run in an
 *      extension tab (hls.html) that lives as long as the user keeps it open.
 */
'use strict';

// Chrome's service worker can't use background.scripts, so it loads the shared
// helpers itself. Firefox already loaded lib/common.js via the manifest and has
// no importScripts in an event page.
if (typeof importScripts === 'function' && typeof CVS === 'undefined') {
  importScripts('lib/common.js');
}

const { api, IS_FIREFOX, stateArea, tabKey, TAB_KEY_PREFIX } = CVS;
const action = api.action ?? api.browserAction;

const MIN_VIDEO_BYTES = 256 * 1024; // smaller than this = preview loop / thumbnail / junk
const MAX_VIDEOS_PER_TAB = 50;
const PROBE_BYTES = 256 * 1024;
const EXT_ORIGIN = api.runtime.getURL('').replace(/\/$/, '');

// YouTube streams are split into separate audio/video range-addressed parts
// (and downloading them is against YouTube's terms), so we never list them.
const IGNORED_HOSTS = ['googlevideo.com', 'youtube.com', 'youtube-nocookie.com', 'ytimg.com'];

// Request types that can never be the video itself.
const IGNORED_TYPES = new Set([
  'image', 'imageset', 'script', 'stylesheet', 'font', 'csp_report', 'ping',
  'beacon', 'web_manifest', 'speculative', 'websocket', 'xslt', 'xml_dtd',
]);

// Extension-less URLs that look like DASH/CMAF segments rather than whole files.
const SEGMENT_PATH_RE = /(?:^|[\/_-])(?:seg|segment|chunk|frag|fragment|init)[-_]?\d*(?:[\/_.-]|$)/i;

// Heuristic for DRM licence / certificate requests. If a page makes one of
// these, the player is using Encrypted Media Extensions and we refuse to
// download anything from that tab.
const DRM_URL_RE =
  /(widevine|playready|fairplay|drmtoday|ezdrm|axinom|buydrm|vualto|vudrm|expressplay|irdeto|castlabs|\budrm\.|\/drm\/|[?&]drm=|license[-_]?(?:server|proxy|acquisition)|getlicense|acquirelicense|\/wvproxy|\/fpsproxy|rightsmanager\.asmx)/i;

const MSG_EXPIRED =
  'This video link has expired or is no longer authorised (HTTP {status}). Signed video URLs only work for a ' +
  'short time. Go back to the course page, play the video for a few seconds to capture a fresh link, then try again.';
const MSG_DRM =
  'This video is DRM-protected or encrypted. Canvas Video Saver does not download protected content.';

// ---------------------------------------------------------------------------
// State cache (see lifecycle notes above)
// ---------------------------------------------------------------------------
/** @type {Map<number, TabState>} */
const tabStates = new Map();
let settings = { ...CVS.DEFAULT_SETTINGS };
let hydrated = null;

function ready() {
  return (hydrated ??= hydrate());
}

async function hydrate() {
  settings = await CVS.getSettings();
  const [all, openTabs] = await Promise.all([stateArea.get(null), api.tabs.query({})]);
  const open = new Set(openTabs.map((t) => t.id));
  const stale = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(TAB_KEY_PREFIX) || !v) continue;
    // storage.local fallback survives restarts and tab ids are reused, so
    // drop anything belonging to a tab that no longer exists.
    if (open.has(v.tabId)) tabStates.set(v.tabId, v);
    else stale.push(k);
  }
  if (stale.length) await stateArea.remove(stale);
}

// All state mutations go through this queue so that concurrent events (a
// player fires many range requests at once) can't interleave across awaits.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(ready).then(fn);
  chain = p.catch((e) => console.warn('[CVS]', e));
  return p;
}

let writeChain = Promise.resolve();
function persist(tabId) {
  const st = tabStates.get(tabId);
  writeChain = writeChain
    .then(() => (st ? stateArea.set({ [tabKey(tabId)]: st }) : stateArea.remove(tabKey(tabId))))
    .catch((e) => console.warn('[CVS] persist failed', e));
  updateBadge(tabId);
  return writeChain;
}

function newTabState(tabId, pageUrl = '') {
  return { tabId, pageUrl, title: '', drm: false, videos: [], hlsChildren: {} };
}

function ensureTab(tabId) {
  let st = tabStates.get(tabId);
  if (!st) {
    st = newTabState(tabId);
    tabStates.set(tabId, st);
  }
  return st;
}

async function refreshPageInfo(st) {
  try {
    const tab = await api.tabs.get(st.tabId);
    // url/title are visible to us because of host_permissions; no "tabs"
    // permission needed.
    if (tab.url) st.pageUrl = st.pageUrl || tab.url;
    if (tab.title) st.title = tab.title;
  } catch {
    /* tab closed */
  }
}

function resetTab(tabId, pageUrl) {
  tabStates.set(tabId, newTabState(tabId, pageUrl));
  persist(tabId);
}

function visibleVideos(st) {
  return st.videos.filter((v) => !v.parent);
}

async function updateBadge(tabId) {
  const st = tabStates.get(tabId);
  const n = st ? visibleVideos(st).length : 0;
  try {
    await action.setBadgeText({ tabId, text: n ? String(n) : '' });
    if (n) {
      await action.setBadgeBackgroundColor({ tabId, color: st.drm ? '#6b7280' : '#2563eb' });
      action.setBadgeTextColor?.({ tabId, color: '#ffffff' })?.catch?.(() => {});
    }
  } catch {
    /* tab already closed */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function headerMap(headers) {
  const h = {};
  for (const { name, value } of headers || []) h[name.toLowerCase()] = value ?? '';
  return h;
}

/**
 * RANGE REQUESTS
 * --------------
 * <video> elements rarely download a file in one go. They send
 * `Range: bytes=X-Y` requests and get back `206 Partial Content` responses,
 * one per chunk, each carrying a header like:
 *
 *     Content-Range: bytes 1048576-2097151/734003200
 *                                          ^^^^^^^^^ total size of the file
 *
 * So for a 206 response, Content-Length is just the chunk size; the real
 * size is the number after the slash (or "*" if the server doesn't know).
 * All chunks share one URL, so they collapse into one entry (see
 * CVS.videoKey). When downloading we hand the bare URL to the downloads API,
 * which issues a normal request without a Range header and therefore gets
 * the whole file (200 OK), not a fragment.
 */
function totalSizeFromHeaders(get, status) {
  const cr = get('content-range');
  if (cr) {
    const m = /\/\s*(\d+)\s*$/.exec(cr);
    return m ? Number(m[1]) : null; // "bytes 0-99/*" -> unknown
  }
  if (status === 200) {
    const n = Number(get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null; // a 206 without Content-Range: chunk size only, don't trust it
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function stripHash(url) {
  return String(url || '').split('#')[0];
}

function isIgnoredHost(host) {
  return IGNORED_HOSTS.some((d) => host === d || host.endsWith('.' + d));
}

function fromOurExtension(d) {
  const src = d.initiator || d.originUrl || d.documentUrl || '';
  return src.startsWith(EXT_ORIGIN);
}

async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { credentials: 'include', cache: 'no-store', ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Network observation
//
// All listeners are NON-BLOCKING ("responseHeaders" only, no "blocking" /
// "extraHeaders"). That matters for portability:
//   * Chrome MV3 does not allow blocking webRequest for normal extensions.
//   * Firefox MV3 still allows it but would need "webRequestBlocking".
//   * Chrome's "extraHeaders" option throws in Firefox, and we don't need it:
//     Content-Type, Content-Length and Content-Range are visible without it.
// We never modify or delay a request; we only look at response headers.
// ---------------------------------------------------------------------------
const ALL_URLS = { urls: ['<all_urls>'] };

api.webRequest.onResponseStarted.addListener(onResponseStarted, ALL_URLS, ['responseHeaders']);

function onResponseStarted(d) {
  if (d.tabId < 0 || fromOurExtension(d)) return; // background fetches / our own HLS page

  if (d.type === 'main_frame') {
    // A new document is replacing the page: forget the old page's videos.
    // (Using the response, not the request, so a link that just triggers a
    // file download doesn't wipe the list.)
    const h = headerMap(d.responseHeaders);
    if (/^\s*attachment/i.test(h['content-disposition'] || '') || d.statusCode === 204) return;
    serial(() => resetTab(d.tabId, d.url));
    return;
  }

  if ((d.type === 'xmlhttprequest' || d.type === 'other') && DRM_URL_RE.test(d.url)) {
    serial(() => {
      const st = ensureTab(d.tabId);
      if (!st.drm) {
        st.drm = true;
        persist(d.tabId);
      }
    });
    return;
  }

  if (IGNORED_TYPES.has(d.type)) return;
  if (d.statusCode < 200 || d.statusCode >= 300) return;

  const host = hostOf(d.url);
  if (!host || isIgnoredHost(host)) return;

  const h = headerMap(d.responseHeaders);
  const ct = (h['content-type'] || '').toLowerCase();
  const ext = CVS.extOf(d.url);

  // HLS/DASH segments and audio-only parts: we only want the playlist or the
  // whole file, never the hundreds of small pieces a player streams.
  if (CVS.SEGMENT_EXTS.includes(ext)) return;
  if (/^video\/(mp2t|iso\.segment)|^audio\//.test(ct)) return;

  const kind = CVS.kindFrom(d.url, ct);
  if (!kind) return;

  if (kind !== 'hls' && !ext && SEGMENT_PATH_RE.test(new URL(d.url).pathname)) return;

  const size = totalSizeFromHeaders((n) => h[n], d.statusCode);
  if (kind !== 'hls' && size != null && size < MIN_VIDEO_BYTES) return;

  serial(() =>
    recordVideo(d.tabId, {
      url: d.url,
      kind,
      size,
      ranged: d.statusCode === 206 || !!h['content-range'],
      contentType: ct.split(';')[0],
      source: hostOf(d.documentUrl || d.initiator || d.originUrl || ''),
    }),
  );
}

async function recordVideo(tabId, info) {
  const st = ensureTab(tabId);
  if (!st.pageUrl || !st.title) await refreshPageInfo(st);
  if (!CVS.pageAllowed(st.pageUrl, settings)) return;

  const key = CVS.videoKey(info.url);
  const existing = st.videos.find((v) => v.key === key);
  if (existing) {
    // Same file seen again (next range chunk, or a re-signed URL).
    let changed = false;
    if (existing.url !== info.url) {
      existing.url = info.url; // keep the freshest signed URL
      if (existing.status === 'expired') existing.status = null;
      changed = true;
    }
    if (info.size && existing.size !== info.size) {
      existing.size = info.size;
      changed = true;
    }
    if (info.ranged && !existing.ranged) {
      existing.ranged = true;
      changed = true;
    }
    if (changed) persist(tabId);
    return;
  }
  if (st.videos.length >= MAX_VIDEOS_PER_TAB) return;

  const v = {
    key,
    url: info.url,
    kind: info.kind,
    size: info.size,
    ranged: info.ranged,
    contentType: info.contentType,
    source: info.source,
    pageTitle: st.title,
    detectedAt: Date.now(),
    parent: st.hlsChildren[key] || null,
    status: null,
  };
  st.videos.push(v);
  persist(tabId);

  if (v.kind === 'hls') classifyHls(tabId, key, info.url); // not awaited: runs outside the queue
}

/**
 * HLS PARSING (background part)
 * Fetch the small playlist text once to find out whether it is a master or a
 * media playlist. Variant/rendition playlists referenced by a master are
 * marked as its children and hidden, so the popup shows one entry per video
 * instead of one per bitrate. Encryption (#EXT-X-KEY / #EXT-X-SESSION-KEY)
 * marks the entry as protected.
 */
async function classifyHls(tabId, key, url) {
  let result;
  try {
    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) {
      result = { httpStatus: res.status };
    } else {
      const text = await res.text();
      result = { playlist: CVS.parseM3U8(text, res.url || url) };
    }
  } catch (e) {
    return; // not fatal - the downloader page will parse it again
  }

  await serial(() => {
    const st = tabStates.get(tabId);
    const v = st?.videos.find((x) => x.key === key);
    if (!v) return;
    if (result.httpStatus) {
      if ([401, 403, 410].includes(result.httpStatus)) v.status = 'expired';
      persist(tabId);
      return;
    }
    const pl = result.playlist;
    v.hlsKind = pl.kind;
    if (pl.kind === 'master') {
      const best = pl.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
      v.variantCount = pl.variants.length;
      v.resolution = best?.resolution || '';
      v.protected = !!pl.encrypted;
      const childUris = pl.variants.map((x) => x.uri).concat(pl.media.map((m) => m.uri).filter(Boolean));
      for (const uri of childUris) {
        const ck = CVS.videoKey(uri);
        if (ck === key) continue;
        st.hlsChildren[ck] = key;
        const child = st.videos.find((x) => x.key === ck);
        if (child) {
          child.parent = key;
          if (child.protected) v.protected = true;
        }
      }
    } else {
      v.duration = pl.duration;
      v.live = !pl.endList;
      v.protected = !!pl.encrypted;
      // An encrypted variant makes the whole master protected.
      if (v.protected && v.parent) {
        const parent = st.videos.find((x) => x.key === v.parent);
        if (parent) parent.protected = true;
      }
    }
    persist(tabId);
  });
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------
api.tabs.onRemoved.addListener((tabId) => {
  serial(() => {
    tabStates.delete(tabId);
    persist(tabId);
  });
});

// Fallback for navigations that don't produce a main_frame response we can
// see (same-document history.pushState navigations, back/forward cache).
// Hash-only changes are ignored.
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  serial(() => {
    const st = tabStates.get(tabId);
    if (st && st.pageUrl && stripHash(st.pageUrl) !== stripHash(changeInfo.url)) resetTab(tabId, changeInfo.url);
  });
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...CVS.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  }
});

api.runtime.onInstalled.addListener(async () => {
  // Firefox MV3 treats host permissions as user-grantable; if they were not
  // granted at install, open the options page, which has a "Grant" button.
  const granted = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  if (!granted) api.runtime.openOptionsPage();
});

api.runtime.onStartup.addListener(() => {
  ready(); // prunes leftovers from the storage.local fallback
});

// ---------------------------------------------------------------------------
// Downloads (MP4 / WebM)
// ---------------------------------------------------------------------------
async function readUpTo(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let off = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - off);
    out.set(part, off);
    off += part.length;
    if (off >= out.length) break;
  }
  return out;
}

/**
 * Before handing a URL to the downloads API, fetch its first 256 KB with a
 * Range request. This tells us:
 *   - whether the signed URL is still valid (403/410 -> expired),
 *   - the full size (from Content-Range),
 *   - whether the MP4 is Common-Encryption protected (DRM).
 * The probe is advisory: a network error means "unknown", and we proceed.
 */
async function probe(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
    if ([401, 403, 410].includes(res.status)) return { state: 'expired', http: res.status };
    if (!res.ok) return { state: 'unknown', http: res.status };
    const size = totalSizeFromHeaders((n) => res.headers.get(n), res.status);
    const bytes = await readUpTo(res, PROBE_BYTES);
    return { state: 'ok', size, encrypted: CVS.sniffMp4Encrypted(bytes) };
  } catch (e) {
    return { state: 'unknown', error: String(e?.message || e) };
  }
}

function findVideo(tabId, key) {
  const st = tabStates.get(tabId);
  return { st, v: st?.videos.find((x) => x.key === key) };
}

function setVideoFields(tabId, key, fields) {
  return serial(() => {
    const { v } = findVideo(tabId, key);
    if (!v) return;
    Object.assign(v, fields);
    persist(tabId);
  });
}

async function downloadVideo({ tabId, key, baseName, force }) {
  await ready();
  const { st, v } = findVideo(tabId, key);
  if (!v) return { ok: false, code: 'missing', message: 'That video is no longer in the list. Replay it and try again.' };
  if (v.kind === 'hls') return { ok: false, code: 'hls', message: 'HLS streams are saved from the HLS download page.' };
  if (st.drm || v.protected) return { ok: false, code: 'drm', message: MSG_DRM };

  const url = v.url;
  const p = await probe(url);
  if (p.state === 'expired' && !force) {
    await setVideoFields(tabId, key, { status: 'expired' });
    return { ok: false, code: 'expired', canForce: true, message: MSG_EXPIRED.replace('{status}', p.http) };
  }
  if (p.encrypted === true) {
    await setVideoFields(tabId, key, { protected: true });
    return { ok: false, code: 'drm', message: MSG_DRM };
  }
  if (p.size) await setVideoFields(tabId, key, { size: p.size });

  const filename = CVS.buildDownloadPath(baseName || v.pageTitle || CVS.basenameOf(url), CVS.extFor(v.kind, url));

  // downloads.download option differences:
  //   * Chrome rejects unknown keys, so Firefox-only options are added only
  //     on Firefox.
  //   * Firefox: `incognito` keeps a private-window download in the private
  //     session (and uses its cookies); `cookieStoreId` does the same for
  //     Multi-Account Containers.
  //   * No Range / Cookie headers are passed - the browser sends the user's
  //     own cookies and requests the whole file.
  const opts = { url, filename, saveAs: !!settings.saveAs, conflictAction: 'uniquify' };
  if (IS_FIREFOX) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (tab?.incognito) opts.incognito = true;
    else if (tab?.cookieStoreId && tab.cookieStoreId !== 'firefox-default') opts.cookieStoreId = tab.cookieStoreId;
  }

  let id;
  try {
    id = await api.downloads.download(opts);
  } catch (e) {
    if (opts.cookieStoreId) {
      delete opts.cookieStoreId; // older Firefox / missing permission: retry plainly
      id = await api.downloads.download(opts);
    } else {
      return { ok: false, code: 'error', message: `The browser refused the download: ${e?.message || e}` };
    }
  }

  // Remember which entry this download belongs to, in storage, because the
  // worker will probably be asleep by the time the download finishes.
  await stateArea.set({ ['dl:' + id]: { tabId, key } });
  await setVideoFields(tabId, key, { status: 'downloading', error: null });
  return { ok: true, id, filename };
}

api.downloads.onChanged.addListener((delta) => {
  if (!delta.state && !delta.error) return;
  serial(async () => {
    const k = 'dl:' + delta.id;
    const rec = (await stateArea.get(k))[k];
    if (!rec) return;
    const state = delta.state?.current;
    if (state === 'in_progress') return;
    const { v } = findVideo(rec.tabId, rec.key);
    let error = delta.error?.current;
    if (state === 'interrupted' && !error) {
      const [item] = await api.downloads.search({ id: delta.id });
      error = item?.error;
    }
    await stateArea.remove(k);
    if (!v) return;
    if (state === 'complete') {
      v.status = 'done';
      v.error = null;
    } else if (error === 'USER_CANCELED') {
      v.status = null;
    } else if (/SERVER_(FORBIDDEN|UNAUTHORIZED|BAD_CONTENT)/.test(error || '')) {
      // 401/403 -> FORBIDDEN/UNAUTHORIZED; 404/410 surface as BAD_CONTENT.
      v.status = 'expired';
      v.error = MSG_EXPIRED.replace('{status}', '403/410');
    } else if (error) {
      v.status = 'failed';
      v.error = `Download failed (${error}).`;
    }
    persist(rec.tabId);
  });
});

// ---------------------------------------------------------------------------
// Messages from our own pages (popup, options, hls downloader)
// ---------------------------------------------------------------------------
const handlers = {
  download: (msg) => downloadVideo(msg),
  clearTab: (msg) =>
    serial(() => {
      const st = tabStates.get(msg.tabId);
      resetTab(msg.tabId, st?.pageUrl || '');
      return { ok: true };
    }),
  setStatus: (msg) => setVideoFields(msg.tabId, msg.key, { status: msg.status, error: msg.error ?? null }).then(() => ({ ok: true })),
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // We have no content scripts, so only our own extension pages can talk to us.
  if (sender.id !== api.runtime.id) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  // `return true` + sendResponse works in both Chrome and Firefox.
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, code: 'error', message: String(e?.message || e) }));
  return true;
});
