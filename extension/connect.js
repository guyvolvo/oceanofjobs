// Runs on oceanofjobs.com. Tells the site the extension is here and takes
// the token the account page posts, so nobody has to copy and paste it.
const ORIGIN = 'https://oceanofjobs.com';

document.documentElement.dataset.oojExtension = '1';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== ORIGIN) return;
  const msg = event.data || {};
  if (msg.type === 'ooj:connect' && typeof msg.token === 'string' && msg.token.startsWith('ooj_')) {
    chrome.storage.local.set({ token: msg.token, authError: false })
      .then(() => window.postMessage({ type: 'ooj:connected' }, ORIGIN));
  } else if (msg.type === 'ooj:disconnect') {
    chrome.storage.local.remove('token');
  }
});
