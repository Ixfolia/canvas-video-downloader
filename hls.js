/*
 * Canvas Video Saver - HLS downloader page (hls.html).
 *
 * WHY A TAB AND NOT THE BACKGROUND / AN OFFSCREEN DOCUMENT?
 * An HLS video is a playlist of hundreds of small segments. Downloading and
 * joining them can take many minutes:
 *   - Chrome's service worker may be terminated after ~30 s idle or 5 min per
 *     event, and it has no URL.createObjectURL() to hand a Blob to the
 *     downloads API.
 *   - chrome.offscreen exists only in Chrome; Firefox has no equivalent, and
 *     offscreen documents can't call chrome.downloads themselves anyway.
 *   - The popup closes as soon as it loses focus.
 * A normal extension tab works identically in both browsers, lives as long as
 * the user keeps it open, can show progress and a Cancel button, and can call
 * the downloads API with a blob: URL directly.
 *
 * WHAT IT DOES (and does not do)
 *   - Parses the playlist (master -> pick a variant -> media playlist).
 *   - Refuses encrypted streams (#EXT-X-KEY / #EXT-X-SESSION-KEY with any
 *     METHOD other than NONE, i.e. AES-128, SAMPLE-AES, FairPlay, Widevine…).
 *     No keys are ever fetched and nothing is decrypted.
 *   - Refuses live streams (no #EXT-X-ENDLIST).
 *   - Fetches segments with the user's own cookies, joins them in order and
 *     saves one file: .ts for MPEG-TS streams, .mp4 for fMP4/CMAF streams
 *     (init segment + fragments = a valid fragmented MP4).
 */
'use strict';

const { api, stateArea, tabKey } = CVS;

const CONCURRENCY = 4;
const RETRIES = 3;
const LARGE_WARNING_BYTES = 2 * 1024 ** 3;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get('tabId'));
const videoKey = params.get('key') || '';
const baseName = CVS.sanitizeFilename(params.get('name') || 'video');

let master = null; // parsed master playlist, if any
let masterUrl = '';
let abortCtrl = null;
let busy = false;

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showMessage(cls, ...parts) {
  const box = $('message');
  box.className = `msg ${cls}`;
  box.replaceChildren(...parts);
  box.hidden = false;
}

function expiredMessage(status) {
  return (
    `The video link has expired or is no longer authorised (HTTP ${status}). Signed video URLs only work ` +
    'for a short time. Go back to the course page, play the video for a few seconds so the extension can ' +
    'capture a fresh link, then click Download again from the toolbar popup.'
  );
}

function protectedMessage() {
  return 'This stream is encrypted (DRM or HLS encryption). Canvas Video Saver does not download protected content.';
}

function reportStatus(status, error) {
  api.runtime.sendMessage({ type: 'setStatus', tabId: sourceTabId, key: videoKey, status, error }).catch(() => {});
}

function fail(e) {
  busy = false;
  $('progressBox').hidden = true;
  if (e?.name === 'AbortError') {
    showMessage('warn', 'Download cancelled.');
    $('setup').hidden = !master;
    return;
  }
  if (e instanceof HttpError && [401, 403, 410].includes(e.status)) {
    const text = expiredMessage(e.status);
    showMessage('err', text);
    reportStatus('expired', text);
    return;
  }
  showMessage('err', String(e?.message || e));
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
async function fetchOnce(url, range, signal) {
  const headers = {};
  if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  const res = await fetch(url, { credentials: 'include', headers, signal });
  if (!res.ok) throw new HttpError(res.status, url);
  let blob = await res.blob();
  // #EXT-X-BYTERANGE segments: if the server ignored our Range header and
  // sent the whole resource (200 instead of 206), cut the slice out ourselves.
  if (range && res.status === 200) blob = blob.slice(range.offset, range.offset + range.length);
  return blob;
}

async function fetchWithRetry(url, range, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, range, signal);
    } catch (e) {
      const fatal =
        e?.name === 'AbortError' ||
        (e instanceof HttpError && [401, 403, 404, 410].includes(e.status)) ||
        attempt >= RETRIES;
      if (fatal) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

async function fetchPlaylist(url, signal) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return CVS.parseM3U8(await res.text(), res.url || url);
}

// ---------------------------------------------------------------------------
// Setup: load the playlist, offer quality choices
// ---------------------------------------------------------------------------
async function init() {
  $('name').textContent = baseName;

  const stored = (await stateArea.get(tabKey(sourceTabId)))[tabKey(sourceTabId)];
  const v = stored?.videos?.find((x) => x.key === videoKey);
  if (!v) {
    showMessage('err', 'This video is no longer in the detected list (was the course tab closed or navigated?). Replay the video and try again from the popup.');
    return;
  }
  if (stored.drm || v.protected) {
    showMessage('err', protectedMessage());
    return;
  }
  masterUrl = v.url;

  let pl;
  try {
    pl = await fetchPlaylist(masterUrl);
  } catch (e) {
    fail(e);
    return;
  }

  if (pl.encrypted) {
    showMessage('err', protectedMessage());
    return;
  }

  const select = $('variant');
  if (pl.kind === 'master') {
    master = pl;
    const variants = pl.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
    if (!variants.length) {
      showMessage('err', 'The playlist has no playable variants.');
      return;
    }
    for (const [i, vr] of variants.entries()) {
      const label = [vr.resolution, vr.bandwidth ? `${Math.round(vr.bandwidth / 1000)} kbps` : '', i === 0 ? '(best)' : '']
        .filter(Boolean)
        .join(' · ');
      select.append(new Option(label || vr.uri, vr.uri));
    }
    select.disabled = variants.length < 2;
    select.addEventListener('change', updateSetupNotes);
  } else {
    // The detected URL was already a media playlist: no choice to make.
    master = { kind: 'master', variants: [{ uri: masterUrl, bandwidth: 0, resolution: '', audio: '' }], media: [] };
    select.append(new Option('Single quality', masterUrl));
    select.disabled = true;
    master._mediaPreloaded = pl;
  }

  $('setup').hidden = false;
  updateSetupNotes();
}

function selectedVariant() {
  return master.variants.find((x) => x.uri === $('variant').value) || master.variants[0];
}

/** If the variant takes its audio from a separate rendition, return it. */
function separateAudioFor(variant) {
  if (!variant.audio) return null;
  const group = master.media.filter((m) => m.type === 'AUDIO' && m.groupId === variant.audio && m.uri);
  return group.find((m) => m.isDefault) || group[0] || null;
}

function updateSetupNotes() {
  const vr = selectedVariant();
  const audio = separateAudioFor(vr);
  $('audioNote').hidden = !audio;
  $('audioNote').textContent = audio
    ? `This stream keeps audio in a separate track (${audio.name || audio.language || 'audio'}). ` +
      'It will be saved as a second file next to the video; see the merge tip after the download.'
    : '';
  const est = master._mediaPreloaded?.duration && vr.bandwidth ? (vr.bandwidth * master._mediaPreloaded.duration) / 8 : 0;
  $('estimate').textContent = est ? `Estimated size: ~${CVS.formatBytes(est)}` : '';
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
async function loadMedia(uri, signal) {
  if (master._mediaPreloaded && uri === masterUrl) return master._mediaPreloaded;
  return fetchPlaylist(uri, signal);
}

function checkMedia(pl) {
  if (pl.kind !== 'media') throw new Error('Expected a media playlist but got another master playlist.');
  if (pl.encrypted) throw new Error(protectedMessage());
  if (!pl.endList) throw new Error('This is a live stream (the playlist has no end). Only finished recordings can be saved.');
  if (!pl.segments.length) throw new Error('The playlist contains no segments.');
}

/**
 * Build the ordered list of byte parts to fetch: the fMP4 init segment
 * (#EXT-X-MAP) first and again whenever it changes, then each segment.
 */
function planParts(pl) {
  const parts = [];
  let lastMap = null;
  for (const seg of pl.segments) {
    if (seg.map && seg.map !== lastMap) {
      parts.push({ uri: seg.map.uri, range: seg.map.range });
      lastMap = seg.map;
    }
    parts.push({ uri: seg.uri, range: seg.range });
  }
  return parts;
}

function outputExt(pl, isAudio) {
  if (pl.container === 'fmp4') return isAudio ? 'm4a' : 'mp4';
  const segExt = CVS.extOf(pl.segments[0].uri);
  if (isAudio && ['aac', 'mp3'].includes(segExt)) return segExt;
  return 'ts';
}

/** Fetch all parts with a small worker pool, keeping them in playlist order. */
async function fetchAll(parts, signal, onProgress) {
  const out = new Array(parts.length);
  let next = 0;
  let done = 0;
  let bytes = 0;
  async function worker() {
    while (next < parts.length) {
      const i = next++;
      const blob = await fetchWithRetry(parts[i].uri, parts[i].range, signal);
      out[i] = blob;
      done++;
      bytes += blob.size;
      onProgress(done, bytes);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker));
  return out;
}

function saveBlob(blob, filename) {
  // Blob URLs are created here (a document), which a Chrome service worker
  // cannot do. The URL must stay valid until the download has finished, so it
  // is revoked from downloads.onChanged rather than immediately.
  const url = URL.createObjectURL(blob);
  return CVS.getSettings().then(async (s) => {
    const id = await api.downloads.download({
      url,
      filename: `${CVS.DOWNLOAD_FOLDER}/${filename}`,
      saveAs: !!s.saveAs,
      conflictAction: 'uniquify',
    });
    return new Promise((resolve) => {
      const listener = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'in_progress') return;
        api.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
        resolve(delta.state.current);
      };
      api.downloads.onChanged.addListener(listener);
    });
  });
}

async function downloadTrack(uri, isAudio, signal, label, nameSuffix) {
  const pl = await loadMedia(uri, signal);
  checkMedia(pl);
  const parts = planParts(pl);
  const t0 = Date.now();
  const blobs = await fetchAll(parts, signal, (done, bytes) => {
    const secs = (Date.now() - t0) / 1000;
    const rate = bytes / Math.max(secs, 0.001);
    const eta = done < parts.length && done > 2 ? ((parts.length - done) * secs) / done : 0;
    $('progress').value = done / parts.length;
    $('progressLabel').textContent =
      `${label}: segment ${done} / ${parts.length} · ${CVS.formatBytes(bytes)} · ${CVS.formatBytes(rate)}/s` +
      (eta ? ` · about ${CVS.formatDuration(eta)} left` : '');
  });
  const ext = outputExt(pl, isAudio);
  const type = ext === 'ts' ? 'video/mp2t' : isAudio ? 'audio/mp4' : 'video/mp4';
  const filename = `${baseName}${nameSuffix}.${ext}`;
  $('progressLabel').textContent = `${label}: saving ${filename}…`;
  const result = await saveBlob(new Blob(blobs, { type }), filename);
  if (result !== 'complete') throw new Error(`Saving ${filename} did not complete (${result}).`);
  return { filename, ext, duration: pl.duration };
}

async function start() {
  if (busy) return;
  const vr = selectedVariant();
  const est = master._mediaPreloaded?.duration && vr.bandwidth ? (vr.bandwidth * master._mediaPreloaded.duration) / 8 : 0;
  if (est > LARGE_WARNING_BYTES &&
      !confirm(`This video is roughly ${CVS.formatBytes(est)}. Segments are held in memory until saved. Continue?`)) {
    return;
  }

  busy = true;
  abortCtrl = new AbortController();
  $('setup').hidden = true;
  $('message').hidden = true;
  $('after').hidden = true;
  $('progressBox').hidden = false;
  reportStatus('downloading', null);

  try {
    const audio = separateAudioFor(vr);
    const video = await downloadTrack(vr.uri, false, abortCtrl.signal, audio ? 'Video' : 'Downloading', '');
    let audioFile = null;
    if (audio) audioFile = await downloadTrack(audio.uri, true, abortCtrl.signal, 'Audio', ' (audio)');

    busy = false;
    $('progressBox').hidden = true;
    showMessage('ok', `Saved to Downloads/${CVS.DOWNLOAD_FOLDER}/${video.filename}` + (audioFile ? ` and ${audioFile.filename}` : ''));
    reportStatus('done', null);
    showTips(video, audioFile);
  } catch (e) {
    fail(e);
    if (e?.name !== 'AbortError' && !(e instanceof HttpError && [401, 403, 410].includes(e.status))) {
      reportStatus('failed', String(e?.message || e));
    }
  }
}

function showTips(video, audioFile) {
  const box = $('after');
  const tips = [];
  if (video.ext === 'ts') {
    tips.push(
      Object.assign(document.createElement('p'), {
        textContent: 'The video was saved as MPEG-TS (.ts). VLC and most players open it directly. To convert to .mp4 without re-encoding:',
      }),
      Object.assign(document.createElement('pre'), {
        textContent: `ffmpeg -i "${video.filename}" -c copy "${baseName}.mp4"`,
      }),
    );
  }
  if (audioFile) {
    tips.push(
      Object.assign(document.createElement('p'), { textContent: 'To merge the separate audio track into the video:' }),
      Object.assign(document.createElement('pre'), {
        textContent: `ffmpeg -i "${video.filename}" -i "${audioFile.filename}" -c copy "${baseName} (merged).mp4"`,
      }),
    );
  }
  box.replaceChildren(...tips);
  box.hidden = !tips.length;
}

$('start').addEventListener('click', start);
$('cancel').addEventListener('click', () => abortCtrl?.abort());
window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

init();
