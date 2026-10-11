/* Canvas Video Saver - options page. */
'use strict';

const { api } = CVS;
const $ = (id) => document.getElementById(id);
const form = $('form');

async function load() {
  const s = await CVS.getSettings();
  for (const r of form.elements.hostMode) r.checked = r.value === s.hostMode;
  $('domains').value = (s.customDomains || []).join('\n');
  $('saveAs').checked = !!s.saveAs;

  const granted = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  $('permPanel').hidden = granted;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const lines = $('domains').value.split(/[\s,]+/);
  const customDomains = [...new Set(lines.map(CVS.normalizeDomain).filter(Boolean))];
  const invalid = lines.map((l) => l.trim()).filter((l) => l && !CVS.normalizeDomain(l));
  const settings = {
    hostMode: form.elements.hostMode.value || 'all',
    customDomains,
    saveAs: $('saveAs').checked,
  };
  await api.storage.local.set({ settings });
  $('domains').value = customDomains.join('\n');
  $('saved').textContent = invalid.length ? `Saved. Ignored invalid entries: ${invalid.join(', ')}` : 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 4000);
});

$('grant').addEventListener('click', () => {
  // Called synchronously in the click handler: permissions.request needs a user gesture.
  api.permissions.request({ origins: ['<all_urls>'] }).then(load);
});

load();

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
const STATE_AREA_NAME = api.storage.session ? 'session' : 'local';
let lastPing = null;
let lastDiag = null;

function li(cls, ...parts) {
  const node = document.createElement('li');
  if (cls) node.className = cls;
  node.append(...parts);
  return node;
}

async function renderDiagnostics() {
  const granted = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => null);
  lastPing = await api.runtime.sendMessage({ type: 'ping' }).catch((e) => ({ ok: false, message: String(e?.message || e) }));
  lastDiag = (await CVS.stateArea.get('diag')).diag || { entries: [] };

  const status = [
    li('', `Browser: ${navigator.userAgent}`),
    li('', `Extension version: ${api.runtime.getManifest().version}`),
    li(granted ? 'good' : 'bad', `Site access (<all_urls>): ${granted ? 'granted' : 'NOT granted - click "Grant site access" above'}`),
    lastPing?.ok
      ? li('good', `Background script: running (${lastPing.responses} network responses observed since it last started)`)
      : li('bad', `Background script: not responding (${lastPing?.message || 'no reply'}). Check about:debugging → Inspect for errors.`),
  ];
  $('diagStatus').replaceChildren(...status);

  const tabs = (lastPing?.tabs || []).filter((t) => t.count > 0);
  $('diagTabs').replaceChildren(
    ...(tabs.length
      ? tabs.map((t) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'link';
          btn.textContent = 'Open list';
          btn.addEventListener('click', () => api.tabs.create({ url: api.runtime.getURL(`popup.html?tabId=${t.tabId}`) }));
          return li('', `${t.title || t.pageUrl} – ${t.count} video${t.count === 1 ? '' : 's'}${t.drm ? ' (DRM)' : ''} `, btn);
        })
      : [li('muted', 'None yet.')]),
  );

  const rows = lastDiag.entries.slice().reverse().map((e) => {
    const tr = document.createElement('tr');
    const cells = [
      new Date(e.time).toLocaleTimeString(),
      e.verdict + (e.count > 1 ? ` (×${e.count})` : ''),
      `${e.type || ''} ${e.status || ''}`,
      e.contentType || '',
      e.url,
    ];
    for (const [i, c] of cells.entries()) {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 1 && e.verdict.startsWith('listed')) td.className = 'listed';
      tr.append(td);
    }
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'muted';
    td.textContent = 'No media requests seen yet. Play a video in another tab, then click Refresh.';
    tr.append(td);
    rows.push(tr);
  }
  $('diagRows').replaceChildren(...rows);
}

function reportText() {
  const lines = [
    'Canvas Video Saver diagnostics',
    ...[...$('diagStatus').children].map((n) => '- ' + n.textContent),
    '',
    'Recent media requests (newest first):',
    ...(lastDiag?.entries || [])
      .slice()
      .reverse()
      .map((e) => `${new Date(e.time).toLocaleTimeString()} | ${e.verdict} x${e.count} | ${e.type} ${e.status} | ${e.contentType} | ${e.url}`),
  ];
  return lines.join('\n');
}

$('diagRefresh').addEventListener('click', renderDiagnostics);
$('diagClear').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'clearDiag' }).catch(() => {});
  renderDiagnostics();
});
$('diagCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportText());
    $('diagMsg').textContent = 'Copied.';
  } catch {
    $('diagMsg').textContent = 'Copy failed - select the table and copy manually.';
  }
  setTimeout(() => ($('diagMsg').textContent = ''), 3000);
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === STATE_AREA_NAME && changes.diag) renderDiagnostics();
});

renderDiagnostics();
