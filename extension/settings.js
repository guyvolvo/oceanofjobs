// The settings view: where the CV, the Workday password and the own AI key
// are saved (this computer or the account), the fill button's reach, and
// the account. Drawn in the popup (popup.html) and, when a file picker
// would close the popup, in a tab (options.html). background.js keeps the
// values (storageState, setStorageMode, saveCv, saveSecrets).
(function () {
  const PROVIDERS = globalThis.oojProviders;
  const MAX_CV = 5 * 1024 * 1024;
  const CV_TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const ALL_SITES = { origins: ['https://*/*'] };
  const send = (msg) => chrome.runtime.sendMessage(msg);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  // Workday's usual rules: 8 or more characters with a lower and an upper
  // case letter, a number and a symbol.
  const workdayOk = (p) => p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);
  // The popup closes when a file picker takes focus, except on Windows;
  // elsewhere the picker opens in the tab version of this view.
  const pickerClosesPopup = () => !/win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  };

  function mount(root, { inPopup = false, onBack = null } = {}) {
    let st = null;
    let confirming = null; // 'account' | 'local' while the mode change waits for a yes

    root.innerHTML = `
      ${inPopup ? `<div class="p-head"><button type="button" class="icon-btn" id="s-back" aria-label="Back">${ICONS.back}</button>Settings</div>` : ''}
      <section class="p-sec" aria-labelledby="s-mode-h">
        <h3 id="s-mode-h">Save my settings to</h3>
        <div class="seg" role="radiogroup" aria-labelledby="s-mode-h">
          <button type="button" role="radio" data-mode="local">Local storage</button>
          <button type="button" role="radio" data-mode="account">Cloud storage</button>
        </div>
        <p class="note" id="s-mode-note"></p>
        <div class="confirm" id="s-confirm" hidden></div>
      </section>
      <section class="p-sec" aria-labelledby="s-cv-h">
        <h3 id="s-cv-h">Resume</h3>
        <div id="s-cv"></div>
        <input type="file" id="s-cv-file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
        <p class="note" id="s-cv-msg" role="status"></p>
      </section>
      <section class="p-sec" aria-labelledby="s-wd-h">
        <h3 id="s-wd-h">Workday password</h3>
        <p class="note">Signs you in on Workday careers sites, and creates an account when you don't have one.</p>
        <div class="pw"><input class="input" type="password" id="s-wd" autocomplete="new-password" spellcheck="false" aria-labelledby="s-wd-h"><button type="button" id="s-wd-show">Show</button></div>
        <div class="row"><button type="button" class="btn sm primary" id="s-wd-save">Save</button><button type="button" class="btn sm" id="s-wd-gen">Generate</button></div>
        <p class="note" id="s-wd-msg" role="status"></p>
      </section>
      <section class="p-sec">
        <details id="s-ai">
          <summary class="disc"><span>Your own AI key</span><span id="s-ai-sum" class="muted"></span></summary>
          <label class="field" for="s-ai-provider">Provider<select class="input" id="s-ai-provider"><option value="">None</option></select></label>
          <label class="field" for="s-ai-key">API key<input class="input" type="password" id="s-ai-key" autocomplete="off" spellcheck="false"></label>
          <label class="field" for="s-ai-model">Model<input class="input" type="text" id="s-ai-model" spellcheck="false" placeholder="Enter the model name used by your provider"></label>
          <p class="note">Used after your plan's monthly AI answers run out.</p>
          <div class="row"><button type="button" class="btn sm primary" id="s-ai-save">Save</button></div>
          <p class="note" id="s-ai-msg" role="status"></p>
        </details>
      </section>
      <section class="p-sec">
        <label class="switch"><input type="checkbox" role="switch" id="s-all"><i aria-hidden="true"></i><span>Show the Fill button on every careers page</span></label>
        <p class="note" id="s-all-msg" role="status"></p>
      </section>
      <section class="p-sec" aria-labelledby="s-acct-h">
        <h3 id="s-acct-h">Account</h3>
        <div class="row between"><span class="note" id="s-acct"></span><button type="button" class="btn sm" id="s-disconnect">Disconnect</button></div>
      </section>`;
    const $ = (id) => root.querySelector('#' + id);
    for (const [value, p] of Object.entries(PROVIDERS)) $('s-ai-provider').add(new Option(p.label, value));
    if (inPopup) $('s-back').addEventListener('click', () => onBack && onBack());
    const say = (id, text, bad = false) => { const el = $(id); el.textContent = text; el.classList.toggle('error', bad); };

    function paint() {
      const account = st.mode === 'account';
      for (const b of root.querySelectorAll('.seg button')) {
        const on = b.dataset.mode === st.mode;
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('on', on);
        b.disabled = b.dataset.mode === 'account' && !account && (!st.connected || !st.ready);
      }
      $('s-mode-note').textContent = !st.connected ? 'Connect your account to use cloud storage.'
        : !st.ready && !account ? "Cloud storage isn't available yet."
          : account ? 'Your resume, Workday password and AI key are saved to your account, encrypted.'
            : 'Your resume, Workday password and AI key are saved only on this computer.';
      const c = $('s-confirm');
      c.hidden = !confirming;
      if (confirming === 'account') {
        c.innerHTML = `<b>Save your settings to cloud storage?</b>
          <label class="check"><input type="checkbox" id="s-agree"> <span>I agree to the <a href="https://oceanofjobs.com/privacy" target="_blank" rel="noopener">Privacy Policy</a>. My resume, Workday password and AI key are saved to my account, encrypted.</span></label>
          <div class="row"><button type="button" class="btn sm primary" id="s-yes" disabled>Save to cloud storage</button><button type="button" class="btn sm" id="s-no">Cancel</button></div>`;
        c.querySelector('#s-agree').addEventListener('change', (e) => { c.querySelector('#s-yes').disabled = !e.target.checked; });
      } else if (confirming === 'local') {
        c.innerHTML = `<b>Switch to local storage?</b>
          <p class="note">Your resume, Workday password and AI key are deleted from your account, and other computers won't have them.</p>
          <div class="row"><button type="button" class="btn sm primary" id="s-yes">Delete from my account</button><button type="button" class="btn sm" id="s-no">Cancel</button></div>`;
      }
      if (confirming) {
        c.querySelector('#s-no').addEventListener('click', () => { confirming = null; paint(); });
        c.querySelector('#s-yes').addEventListener('click', () => changeMode(confirming));
      }

      const cv = st.cv;
      const pick = `<button type="button" class="btn sm" id="s-cv-pick">${ICONS.up}${cv ? 'Replace' : 'Choose a file'}</button>`;
      $('s-cv').innerHTML = cv ? `
        <div class="file"><span class="doc">${cv.type === CV_TYPES.pdf ? 'PDF' : 'DOCX'}</span>
          <span class="meta"><b title="${esc(cv.name)}">${esc(cv.name)}</b><span>${[kb(cv.size), cv.savedAt ? `added ${day(cv.savedAt)}` : ''].filter(Boolean).join(', ')}</span></span></div>
        <div class="row">${pick}<button type="button" class="btn sm" id="s-cv-remove">Remove</button></div>`
        : `<div class="banner"><b>Add your resume to start applying</b><p class="note">PDF or DOCX, up to 5 MB.</p><div class="row">${pick}</div></div>`;
      $('s-cv-pick').addEventListener('click', pickCv);
      if (cv) $('s-cv-remove').addEventListener('click', removeCv);

      $('s-ai-sum').innerHTML = (st.ai ? esc((PROVIDERS[st.ai.provider] || {}).label || st.ai.provider) : 'Not added') + ICONS.chev;
      $('s-acct').textContent = st.connected ? 'Connected to your Ocean of Jobs account.' : 'Not connected to an Ocean of Jobs account.';
      $('s-disconnect').disabled = !st.connected;
    }

    async function refresh(sync) {
      const next = await send({ type: sync ? 'storageSync' : 'storageState' });
      if (next && !next.error) st = next;
      paint();
    }

    async function changeMode(mode) {
      const yes = $('s-confirm').querySelector('#s-yes');
      if (yes) yes.disabled = true;
      const r = await send({ type: 'storageMode', mode, consent: mode === 'account' });
      confirming = null;
      if (r && r.error) { paint(); say('s-mode-note', r.error, true); return; }
      st = r;
      paint();
    }
    root.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.mode === st.mode || b.disabled) return;
      confirming = b.dataset.mode;
      paint();
    }));

    function pickCv() {
      if (inPopup && pickerClosesPopup()) {
        chrome.runtime.openOptionsPage();
        window.close();
        return;
      }
      $('s-cv-file').click();
    }
    $('s-cv-file').addEventListener('change', async () => {
      const file = $('s-cv-file').files[0];
      $('s-cv-file').value = '';
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (!CV_TYPES[ext]) return say('s-cv-msg', 'Choose a PDF or DOCX file.', true);
      if (file.size > MAX_CV) return say('s-cv-msg', 'This file is larger than 5 MB.', true);
      say('s-cv-msg', 'Saving…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await send({ type: 'storageCv', cv: { name: file.name, type: CV_TYPES[ext], size: file.size, data: btoa(bin) } });
      if (r && r.error) return say('s-cv-msg', r.error, true);
      st = r;
      paint();
      say('s-cv-msg', st.mode === 'account' ? 'Resume saved to your account.' : 'Resume saved.');
    });
    async function removeCv() {
      const r = await send({ type: 'storageCv', cv: null });
      if (r && r.error) return say('s-cv-msg', r.error, true);
      st = r;
      paint();
      say('s-cv-msg', 'Resume removed.');
    }

    $('s-wd-show').addEventListener('click', () => {
      const shown = $('s-wd').type === 'text';
      $('s-wd').type = shown ? 'password' : 'text';
      $('s-wd-show').textContent = shown ? 'Show' : 'Hide';
    });
    $('s-wd-gen').addEventListener('click', () => {
      const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%&*?'];
      const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
      // Four of each kind, shuffled, so every rule above holds.
      $('s-wd').value = Array.from({ length: 16 }, (_, i) => pick(sets[i % 4])).sort(() => crypto.getRandomValues(new Int8Array(1))[0]).join('');
      $('s-wd').type = 'text';
      $('s-wd-show').textContent = 'Hide';
      say('s-wd-msg', 'Save this password somewhere safe, then click Save.');
    });
    $('s-wd-save').addEventListener('click', async () => {
      const pw = $('s-wd').value;
      if (pw && !workdayOk(pw)) return say('s-wd-msg', 'Use at least 8 characters, including uppercase and lowercase letters, a number, and a symbol.', true);
      const r = await send({ type: 'storageSecrets', change: { workday: pw || null } });
      if (r && r.error) return say('s-wd-msg', r.error, true);
      st = r;
      $('s-wd').type = 'password';
      $('s-wd-show').textContent = 'Show';
      say('s-wd-msg', pw ? 'Saved.' : 'Your Workday password was removed.');
    });

    $('s-ai-provider').addEventListener('change', () => {
      const p = PROVIDERS[$('s-ai-provider').value];
      $('s-ai-model').value = (p && p.model) || '';
    });
    $('s-ai-save').addEventListener('click', async () => {
      const provider = $('s-ai-provider').value;
      const key = $('s-ai-key').value.trim();
      if (!provider) {
        const r = await send({ type: 'storageSecrets', change: { ai: null } });
        if (r && r.error) return say('s-ai-msg', r.error, true);
        st = r;
        $('s-ai-key').value = $('s-ai-model').value = '';
        paint();
        return say('s-ai-msg', 'Your AI key was removed.');
      }
      if (!key) return say('s-ai-msg', 'Enter your API key.', true);
      const model = $('s-ai-model').value.trim() || PROVIDERS[provider].model;
      if (!model) return say('s-ai-msg', 'Enter a model name.', true);
      // Asked here, on a click, because Chrome only grants host access from a user gesture.
      const granted = await chrome.permissions.request({ origins: [PROVIDERS[provider].origin] });
      if (!granted) return say('s-ai-msg', "Chrome denied access to the provider, so your key wasn't saved. Click Save and allow access.", true);
      const r = await send({ type: 'storageSecrets', change: { ai: { provider, key, model } } });
      if (r && r.error) return say('s-ai-msg', r.error, true);
      st = r;
      paint();
      say('s-ai-msg', 'Saved.');
    });

    // The background registers or drops the fill button for every site when
    // the permission changes (chrome.permissions.onAdded and onRemoved).
    $('s-all').addEventListener('change', async () => {
      const on = $('s-all').checked;
      const ok = on ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES);
      $('s-all').checked = await chrome.permissions.contains(ALL_SITES);
      say('s-all-msg', !ok ? "Chrome couldn't change site access."
        : on ? 'Enabled. Reload a careers page to show the button.' : 'Disabled. The button will appear only on supported hiring sites, such as Greenhouse, Lever, and Workday.');
    });
    chrome.permissions.contains(ALL_SITES).then((on) => { $('s-all').checked = on; });

    $('s-disconnect').addEventListener('click', async () => {
      await chrome.storage.local.remove(['token', 'authError', 'needs']);
      st.connected = false;
      paint();
      $('s-acct').textContent = 'Disconnected. You can connect again from your account page.';
    });

    // The saved values, for editing: the password and key stay hidden until
    // asked for. Read again after the account's copy comes down.
    const fillInputs = () => chrome.storage.local.get(['workday', 'ai']).then(({ workday, ai }) => {
      $('s-wd').value = workday ? workday.password : '';
      $('s-ai-provider').value = ai ? ai.provider : '';
      $('s-ai-key').value = ai ? ai.key : '';
      $('s-ai-model').value = ai ? ai.model || '' : '';
    });
    st = { connected: false, mode: 'local', ready: false, cv: null, workday: false, ai: null };
    paint();
    fillInputs();
    refresh(false).then(() => refresh(true)).then(fillInputs);
  }

  globalThis.oojSettings = { mount };
})();
