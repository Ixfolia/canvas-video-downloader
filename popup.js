/* Canvas Video Saver - popup. Shows the videos detected on the active tab. */
'use strict';

const { api, stateArea, tabKey } = CVS;
const STATE_AREA_NAME = api.storage.session ? 'session' : 'local';

const $ = (id) => document.getElementById(id);

let activeTab = null;
let tabState = null;
let settings = { ...CVS.DEFAULT_SETTINGS };
let hasPermission = true;
/** Transient per-video messages from the last button press (key -> {cls, text, canForce}). */
const notes = new Map();

/** Tiny DOM builder - never uses innerHTML, page titles/URLs are untrusted. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function send(msg) {
  return api.runtime.sendMessage(msg).catch((e) => ({ ok: false, message: String(e?.message || e) }));
}

function visibleVideos() {
  return (tabState?.videos || []).filter((v) => !v.parent);
}

function isProtected(v) {
  return !!(tabState?.drm || v.protected);
}

/** Filename (without extension) based on the tab title, numbered if needed. */
function baseNameFor(v, index, total) {
  const title = activeTab?.title || v.pageTitle || CVS.basenameOf(v.url) || 'video';
  const base = CVS.sanitizeFilename(title);
  return total > 1 ? `${base} (${index + 1})` : base;
}

function typeLabel(v) {
  if (v.kind === 'hls') return 'HLS';
  if (v.kind === 'webm') return 'WebM';
  return 'MP4';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderBanners() {
  const box = $('banners');
  box.replaceChildren();

  if (!hasPermission) {
    box.append(
      el('div', { class: 'banner warn' },
        'Site access has not been granted, so videos cannot be detected.',
        el('br'),
        el('button', { class: 'primary', type: 'button', onclick: requestPermission }, 'Grant access'),
      ),
    );
  }

  if (activeTab?.url && !CVS.pageAllowed(activeTab.url, settings)) {
    box.append(
      el('div', { class: 'banner warn' },
        'Restricted mode: this site is not *.instructure.com or one of your custom domains, so it is not being watched. ',
        el('button', { class: 'link', type: 'button', onclick: () => api.runtime.openOptionsPage() }, 'Change in Options'),
      ),
    );
  }

  if (tabState?.drm) {
    box.append(
      el('div', { class: 'banner err' },
        'This page uses DRM (a licence request was seen). Downloads are disabled for this tab.',
      ),
    );
  }
}

function statusNode(v) {
  const note = notes.get(v.key);
  if (note) {
    return el('div', { class: `status ${note.cls}` },
      note.text,
      note.canForce
        ? el('div', {}, el('button', { class: 'link', type: 'button', onclick: () => download(v, true) }, 'Try the download anyway'))
        : null,
    );
  }
  if (isProtected(v)) return el('div', { class: 'status err' }, 'Protected / encrypted stream - not downloadable.');
  if (v.live) return el('div', { class: 'status warn' }, 'Live stream - only finished recordings can be saved.');
  switch (v.status) {
    case 'expired':
      return el('div', { class: 'status err' },
        v.error ||
          'This link has expired (HTTP 403/410). Replay the video for a few seconds to capture a fresh link, then try again.');
    case 'failed':
      return el('div', { class: 'status err' }, v.error || 'Download failed.');
    case 'downloading':
      return el('div', { class: 'status' }, 'Downloading… (see your browser’s downloads list)');
    case 'done':
      return el('div', { class: 'status ok' }, `Saved to Downloads/${CVS.DOWNLOAD_FOLDER}/`);
    default:
      return null;
  }
}

function renderItem(v, index, total) {
  const base = baseNameFor(v, index, total);
  const ext = v.kind === 'hls' ? '' : '.' + CVS.extFor(v.kind, v.url);
  const meta = [
    el('span', { class: `pill ${v.kind === 'hls' ? 'hls' : 'mp4'}` }, typeLabel(v)),
    isProtected(v) ? el('span', { class: 'pill lock' }, 'DRM') : null,
    v.size ? el('span', {}, CVS.formatBytes(v.size)) : null,
    v.duration ? el('span', {}, CVS.formatDuration(v.duration)) : null,
    v.resolution ? el('span', {}, v.resolution) : null,
    v.variantCount > 1 ? el('span', {}, `${v.variantCount} qualities`) : null,
    v.ranged ? el('span', { title: 'The player streamed this file in Range chunks; the download fetches the whole file.' }, 'streamed') : null,
    el('span', { title: v.url }, (v.source && v.source !== hostOf(v.url) ? `${v.source} → ` : '') + hostOf(v.url)),
  ];

  const blocked = isProtected(v) || v.live;
  return el('li', { class: 'item' },
    el('div', { class: 'name', title: v.url }, base + ext),
    el('div', { class: 'meta' }, meta),
    statusNode(v),
    el('div', { class: 'actions' },
      el('button', {
        class: 'primary', type: 'button', disabled: blocked,
        onclick: () => (v.kind === 'hls' ? openHlsDownloader(v, base) : download(v, false)),
      }, 'Download'),
      el('button', { type: 'button', onclick: (e) => copyUrl(v, e.currentTarget) }, 'Copy URL'),
    ),
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function render() {
  const vids = visibleVideos();
  $('count').textContent = vids.length ? `${vids.length} video${vids.length === 1 ? '' : 's'}` : '';
  $('empty').hidden = vids.length > 0;
  $('list').replaceChildren(...vids.map((v, i) => renderItem(v, i, vids.length)));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function download(v, force) {
  const vids = visibleVideos();
  const idx = vids.findIndex((x) => x.key === v.key);
  notes.set(v.key, { cls: '', text: 'Checking link…' });
  render();
  const res = await send({
    type: 'download',
    tabId: activeTab.id,
    key: v.key,
    baseName: baseNameFor(v, idx, vids.length),
    force,
  });
  if (res?.ok) {
    notes.set(v.key, { cls: 'ok', text: `Downloading to ${res.filename}` });
  } else {
    notes.set(v.key, {
      cls: res?.code === 'expired' ? 'err' : res?.code === 'drm' ? 'err' : 'warn',
      text: res?.message || 'Download failed.',
      canForce: !!res?.canForce,
    });
  }
  render();
}

/**
 * HLS downloads can take minutes and hundreds of requests, which is too long
 * for the popup (closes on blur) or the Chrome service worker (can be killed).
 * They run in a normal extension tab instead - see hls.js.
 */
async function openHlsDownloader(v, base) {
  const params = new URLSearchParams({ tabId: String(activeTab.id), key: v.key, name: base });
  await api.tabs.create({ url: api.runtime.getURL('hls.html') + '?' + params, index: activeTab.index + 1 });
  window.close();
}

async function copyUrl(v, button) {
  try {
    await navigator.clipboard.writeText(v.url);
  } catch {
    // Fallback for browsers that refuse the async clipboard in popups.
    const ta = el('textarea', { value: v.url });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = button.textContent;
  button.textContent = 'Copied!';
  setTimeout(() => (button.textContent = old), 1200);
}

function requestPermission() {
  // Must be called synchronously inside the click handler (user gesture),
  // especially in Firefox - no await before this line.
  api.permissions.request({ origins: ['<all_urls>'] }).then((granted) => {
    if (granted) init();
  });
}

// ---------------------------------------------------------------------------
// Init + live updates
// ---------------------------------------------------------------------------
async function init() {
  [activeTab] = await api.tabs.query({ active: true, currentWindow: true });
  const [stored, s, granted] = await Promise.all([
    stateArea.get(tabKey(activeTab.id)),
    CVS.getSettings(),
    api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true),
  ]);
  tabState = stored[tabKey(activeTab.id)] || null;
  settings = s;
  hasPermission = granted;
  renderBanners();
  render();
}

api.storage.onChanged.addListener((changes, area) => {
  if (!activeTab || area !== STATE_AREA_NAME) return;
  const change = changes[tabKey(activeTab.id)];
  if (!change) return;
  tabState = change.newValue || null;
  // Background status supersedes the transient note once it reports a result.
  for (const v of tabState?.videos || []) {
    if (['done', 'expired', 'failed'].includes(v.status)) notes.delete(v.key);
  }
  renderBanners();
  render();
});

$('clear').addEventListener('click', async () => {
  notes.clear();
  await send({ type: 'clearTab', tabId: activeTab.id });
});
$('options').addEventListener('click', () => api.runtime.openOptionsPage());

init();
