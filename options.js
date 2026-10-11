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
