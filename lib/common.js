/*
 * Canvas Video Saver - shared helpers.
 *
 * Loaded by:
 *   - background.js (Chrome: via importScripts() inside the service worker;
 *                    Firefox: listed before background.js in background.scripts)
 *   - popup.html, options.html, hls.html (plain <script> tags)
 *
 * Everything is attached to a single global, `CVS`, so it works the same in a
 * service worker, an event page and a normal extension page without modules.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Cross-browser shim.
  // Firefox exposes the promise-based `browser.*` namespace; Chrome exposes
  // `chrome.*`, whose MV3 APIs also return promises when no callback is
  // passed. Every call in this codebase uses the promise form, so the same
  // code runs in both.
  // ---------------------------------------------------------------------------
  const api = global.browser ?? global.chrome;

  const IS_FIREFOX = (() => {
    try {
      return api.runtime.getURL('').startsWith('moz-extension:');
    } catch {
      return false;
    }
  })();

  // storage.session exists in Chrome 102+ and Firefox 115+. It is kept in
  // memory, survives service-worker restarts and is wiped when the browser
  // closes, which is exactly the lifetime we want for per-tab detections.
  // Fall back to storage.local (pruned on startup) if it is unavailable.
  const stateArea = api.storage.session ?? api.storage.local;

  const TAB_KEY_PREFIX = 'tab:';
  const tabKey = (tabId) => TAB_KEY_PREFIX + tabId;

  const DOWNLOAD_FOLDER = 'CanvasVideos';

  const DEFAULT_SETTINGS = Object.freeze({
    // 'all'        -> watch every site (still only media the page itself loads)
    // 'restricted' -> only watch tabs whose top-level page is on
    //                 *.instructure.com or one of customDomains
    hostMode: 'all',
    customDomains: [],
    // Show the browser "Save as" dialog for each download.
    saveAs: false,
  });

  const BUILTIN_DOMAINS = ['instructure.com'];

  async function getSettings() {
    const { settings } = await api.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  /** Normalise a user-entered domain ("*.school.edu", "https://canvas.x.edu/") */
  function normalizeDomain(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return '';
    if (s.includes('://')) {
      try {
        s = new URL(s).hostname;
      } catch {
        return '';
      }
    }
    s = s.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    return /^[a-z0-9.-]+$/.test(s) ? s : '';
  }

  function hostMatches(host, domain) {
    host = String(host || '').toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  }

  /** Is the given page URL allowed under the current settings? */
  function pageAllowed(pageUrl, settings) {
    if (settings.hostMode !== 'restricted') return true;
    let host;
    try {
      host = new URL(pageUrl).hostname;
    } catch {
      return false;
    }
    const domains = BUILTIN_DOMAINS.concat((settings.customDomains || []).map(normalizeDomain)).filter(Boolean);
    return domains.some((d) => hostMatches(host, d));
  }

  // ---------------------------------------------------------------------------
  // URL / media classification
  // ---------------------------------------------------------------------------
  const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov'];
  const HLS_EXTS = ['m3u8'];
  // HLS / DASH segment & sidecar extensions we never want to list.
  const SEGMENT_EXTS = ['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac', 'm4a', 'mp3', 'vtt', 'webvtt', 'key', 'mpd'];

  /** Lower-case extension of the URL path, ignoring query string and hash. */
  function extOf(url) {
    try {
      const path = new URL(url).pathname;
      const m = /\.([a-z0-9]{1,6})$/i.exec(path);
      return m ? m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  /**
   * Stable identity for a detected video.
   *
   * Players re-request the same file many times (one request per Range chunk)
   * and signed CDN URLs often get a new signature/expiry in the query string on
   * each refresh. For URLs with a recognisable media extension we therefore
   * dedupe on origin + path and keep the newest full URL (freshest signature).
   * For extension-less URLs (e.g. /media?id=123) the query string may be the
   * only thing identifying the file, so the full URL is used.
   */
  function videoKey(url) {
    try {
      const u = new URL(url);
      const ext = extOf(url);
      if (VIDEO_EXTS.includes(ext) || HLS_EXTS.includes(ext)) return u.origin + u.pathname;
      u.hash = '';
      return u.href;
    } catch {
      return url;
    }
  }

  function kindFrom(url, contentType) {
    const ct = String(contentType || '').toLowerCase();
    const ext = extOf(url);
    if (HLS_EXTS.includes(ext) || ct.includes('mpegurl')) return 'hls';
    if (ext === 'webm' || ct.startsWith('video/webm')) return 'webm';
    if (VIDEO_EXTS.includes(ext) || ct.startsWith('video/')) return 'mp4';
    return null;
  }

  function extFor(kind, url) {
    const ext = extOf(url);
    if (kind === 'webm') return 'webm';
    if (kind === 'mp4') return VIDEO_EXTS.includes(ext) && ext !== 'webm' ? ext : 'mp4';
    return 'mp4';
  }

  function basenameOf(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] || '');
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Filenames
  // ---------------------------------------------------------------------------
  /**
   * Turn an arbitrary page title into a filename that is legal on Windows,
   * macOS and Linux and accepted by both chrome.downloads and
   * browser.downloads (Firefox throws on illegal characters instead of
   * silently fixing them).
   */
  function sanitizeFilename(name, fallback = 'video', maxLen = 120) {
    let s = String(name ?? '')
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // control chars
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // zero-width / bidi
      .replace(/[<>:"/\\|?*]/g, '_') // illegal on Windows, path separators everywhere
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s~-]+/, '') // no hidden files / option-looking names
      .replace(/[.\s~]+$/, ''); // Windows strips trailing dots/spaces; Chrome dislikes trailing ~

    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s)) s = '_' + s;

    // Truncate by code points so we never split a surrogate pair.
    const chars = Array.from(s);
    if (chars.length > maxLen) s = chars.slice(0, maxLen).join('').replace(/[.\s~]+$/, '');

    return s || fallback;
  }

  function buildDownloadPath(baseName, ext) {
    return `${DOWNLOAD_FOLDER}/${sanitizeFilename(baseName)}.${ext}`;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // ---------------------------------------------------------------------------
  // HLS (m3u8) parsing
  //
  // An HLS URL is either:
  //   * a MASTER playlist: lists variant streams (#EXT-X-STREAM-INF + URI line)
  //     at different bitrates, plus optional alternate renditions
  //     (#EXT-X-MEDIA, e.g. a separate audio track); or
  //   * a MEDIA playlist: the actual list of segments (#EXTINF + URI line),
  //     optionally with an init segment (#EXT-X-MAP, fMP4/CMAF streams),
  //     byte ranges (#EXT-X-BYTERANGE) and encryption (#EXT-X-KEY).
  //
  // We only need enough of RFC 8216 to (a) tell the two apart, (b) find
  // segment URLs, and (c) detect encryption so we can refuse it.
  // ---------------------------------------------------------------------------
  function parseAttributes(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function parseByteRange(spec, lastEnd) {
    // "<length>[@<offset>]" - when the offset is omitted the range starts right
    // after the previous sub-range of the same resource.
    const [len, off] = String(spec).split('@');
    const length = parseInt(len, 10);
    const offset = off !== undefined ? parseInt(off, 10) : lastEnd ?? 0;
    if (!Number.isFinite(length) || !Number.isFinite(offset)) return null;
    return { offset, length };
  }

  function isEncryptingKey(attrs) {
    return attrs && attrs.METHOD && attrs.METHOD.toUpperCase() !== 'NONE';
  }

  function parseM3U8(text, baseUrl) {
    const lines = String(text)
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

    const resolve = (u) => new URL(u, baseUrl).href;
    const tagValue = (line) => line.slice(line.indexOf(':') + 1);

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const media = [];
      const sessionKeys = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const attrs = parseAttributes(tagValue(line));
          // The URI is the next line that is not a tag/comment.
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j < lines.length) {
            variants.push({
              uri: resolve(lines[j]),
              bandwidth: parseInt(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || '0', 10) || 0,
              resolution: attrs.RESOLUTION || '',
              codecs: attrs.CODECS || '',
              audio: attrs.AUDIO || '',
            });
            i = j;
          }
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttributes(tagValue(line));
          media.push({
            type: a.TYPE,
            groupId: a['GROUP-ID'],
            name: a.NAME || '',
            language: a.LANGUAGE || '',
            isDefault: a.DEFAULT === 'YES',
            uri: a.URI ? resolve(a.URI) : null,
          });
        } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
          sessionKeys.push(parseAttributes(tagValue(line)));
        }
      }
      return {
        kind: 'master',
        variants,
        media,
        encrypted: sessionKeys.some(isEncryptingKey),
      };
    }

    const segments = [];
    let duration = 0;
    let pendingDuration = 0;
    let pendingRange = null;
    let discontinuity = false;
    let currentKey = null;
    let currentMap = null;
    let encrypted = false;
    let endList = false;
    const maps = new Map(); // map identity -> map object (to detect changes)
    const lastEndByUri = new Map();

    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(tagValue(line)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = tagValue(line);
      } else if (line.startsWith('#EXT-X-KEY:')) {
        currentKey = parseAttributes(tagValue(line));
        if (isEncryptingKey(currentKey)) encrypted = true;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(tagValue(line));
        const uri = resolve(a.URI);
        const range = a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null;
        const id = uri + '|' + (range ? `${range.offset}-${range.length}` : '');
        if (!maps.has(id)) maps.set(id, { uri, range });
        currentMap = maps.get(id);
      } else if (line === '#EXT-X-DISCONTINUITY') {
        discontinuity = true;
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (!line.startsWith('#')) {
        const uri = resolve(line);
        let range = null;
        if (pendingRange != null) {
          range = parseByteRange(pendingRange, lastEndByUri.get(uri));
          if (range) lastEndByUri.set(uri, range.offset + range.length);
        }
        segments.push({ uri, duration: pendingDuration, range, map: currentMap, discontinuity });
        duration += pendingDuration;
        pendingDuration = 0;
        pendingRange = null;
        discontinuity = false;
      }
    }

    return {
      kind: 'media',
      segments,
      duration,
      encrypted,
      endList,
      mapCount: maps.size,
      // fMP4/CMAF streams declare an init segment; MPEG-TS streams do not.
      container: maps.size ? 'fmp4' : 'ts',
    };
  }

  // ---------------------------------------------------------------------------
  // MP4 encryption sniffing (Common Encryption / DRM)
  //
  // Walk the top-level ISO-BMFF boxes in the first bytes of the file. If the
  // `moov` box is present, look inside it for boxes that only exist in
  // encrypted files: `encv`/`enca` (encrypted sample entries), `sinf`
  // (protection scheme info) and `pssh` (DRM system header). Searching only
  // inside `moov` avoids false positives from random bytes in `mdat`.
  // Returns true / false, or null when we cannot tell (moov not in buffer,
  // not an MP4 at all).
  // ---------------------------------------------------------------------------
  function sniffMp4Encrypted(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const type = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    let off = 0;
    while (off + 8 <= u8.length) {
      let size = dv.getUint32(off);
      const t = type(off + 4);
      let header = 8;
      if (size === 1) {
        if (off + 16 > u8.length) break;
        size = Number(dv.getBigUint64(off + 8));
        header = 16;
      } else if (size === 0) {
        size = u8.length - off;
      }
      if (size < header) break;
      if (t === 'moov') {
        const end = Math.min(off + size, u8.length);
        const needles = ['encv', 'enca', 'sinf', 'pssh'];
        for (let i = off + header; i + 4 <= end; i++) {
          if (needles.includes(type(i))) return true;
        }
        // Partial moov: no evidence of encryption in what we have.
        return off + size <= u8.length ? false : null;
      }
      if (t === 'pssh') return true;
      off += size;
    }
    // No moov yet (e.g. 'mdat' first, or not an MP4 at all): unknown.
    return null;
  }

  global.CVS = {
    api,
    IS_FIREFOX,
    stateArea,
    TAB_KEY_PREFIX,
    tabKey,
    DOWNLOAD_FOLDER,
    DEFAULT_SETTINGS,
    BUILTIN_DOMAINS,
    getSettings,
    normalizeDomain,
    pageAllowed,
    extOf,
    videoKey,
    kindFrom,
    extFor,
    basenameOf,
    sanitizeFilename,
    buildDownloadPath,
    formatBytes,
    formatDuration,
    parseM3U8,
    sniffMp4Encrypted,
    SEGMENT_EXTS,
  };
})(globalThis);
