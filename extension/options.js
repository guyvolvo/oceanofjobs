const $ = (id) => document.getElementById(id);
const MAX_CV = 5 * 1024 * 1024;
const CV_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const PROVIDERS = {
  anthropic: { origin: 'https://api.anthropic.com/*', model: 'claude-haiku-5-5' },
  openai: { origin: 'https://api.openai.com/*', model: '' },
};

function showCv(cv) {
  $('cv-now').textContent = cv ? `Saved: ${cv.name} (${Math.round(cv.size / 1024)} KB)` : 'No CV saved yet.';
}

$('cv').addEventListener('change', async () => {
  const file = $('cv').files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!CV_TYPES[ext]) { $('cv-msg').textContent = 'Use a PDF or DOCX file.'; return; }
  if (file.size > MAX_CV) { $('cv-msg').textContent = 'That file is over 5 MB.'; return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const cv = { name: file.name, type: CV_TYPES[ext], size: file.size, data: btoa(bin) };
  await chrome.storage.local.set({ cv });
  showCv(cv);
  $('cv-msg').textContent = 'CV saved.';
});

$('provider').addEventListener('change', () => {
  const p = PROVIDERS[$('provider').value];
  if (p && !$('model').value) $('model').value = p.model;
});

$('save-ai').addEventListener('click', async () => {
  const provider = $('provider').value;
  const key = $('key').value.trim();
  if (!provider) {
    await chrome.storage.local.remove('ai');
    $('key').value = $('model').value = '';
    $('ai-msg').textContent = 'AI answers are off.';
    return;
  }
  if (!key) { $('ai-msg').textContent = 'Paste your API key first.'; return; }
  const model = $('model').value.trim() || PROVIDERS[provider].model;
  if (!model) { $('ai-msg').textContent = 'Type the model name to use.'; return; }
  // Asked here, on a click, because Chrome only grants host access from a user gesture.
  const granted = await chrome.permissions.request({ origins: [PROVIDERS[provider].origin] });
  if (!granted) { $('ai-msg').textContent = 'Chrome did not allow access to the provider, so nothing was saved.'; return; }
  await chrome.storage.local.set({ ai: { provider, key, model } });
  $('ai-msg').textContent = 'Saved.';
});

// The background registers or drops the fill button for every site when
// the permission changes (chrome.permissions.onAdded and onRemoved).
const ALL_SITES = { origins: ['https://*/*'] };
$('all-sites').addEventListener('change', async () => {
  const on = $('all-sites').checked;
  const ok = on ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES);
  $('all-sites').checked = await chrome.permissions.contains(ALL_SITES);
  $('all-sites-msg').textContent = !ok ? 'Chrome did not change the access.'
    : on ? 'On. Reload a careers page to see the button.' : 'Off. The button shows only on the job sites Ocean of Jobs lists.';
});
chrome.permissions.contains(ALL_SITES).then((on) => { $('all-sites').checked = on; });

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'authError', 'needs']);
  $('account-now').textContent = 'Disconnected. Connect again from your account page.';
});

chrome.storage.local.get(['cv', 'ai', 'token']).then(({ cv, ai, token }) => {
  showCv(cv);
  if (ai) {
    $('provider').value = ai.provider;
    $('key').value = ai.key;
    $('model').value = ai.model;
  }
  $('account-now').textContent = token ? 'Connected to your Ocean of Jobs account.' : 'Not connected.';
  $('disconnect').disabled = !token;
});
