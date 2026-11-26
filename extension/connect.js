// Runs on oceanofjobs.com. Tells the site the extension is here and takes
// the token the account page posts, so nobody has to copy and paste it.
const ORIGIN = 'https://oceanofjobs.com';

document.documentElement.dataset.oojExtension = '1';
// Which extension, so /apply can message this copy: an unpacked one has a
// different id from the Web Store build.
document.documentElement.dataset.oojExtensionId = chrome.runtime.id;

// The token comes only from /apply (apply/src/ext.ts connectExtension) and
// /account. Job pages show scraped text and every page runs analytics, so a
// script there could post its own account's token.
const CONNECT_PAGE = /^\/(apply|account)(\/|$)/;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== ORIGIN || !CONNECT_PAGE.test(location.pathname)) return;
  const msg = event.data || {};
  if (msg.type === 'ooj:connect' && typeof msg.token === 'string' && msg.token.startsWith('ooj_')) {
    chrome.storage.local.set({ token: msg.token, authError: false })
      .then(() => window.postMessage({ type: 'ooj:connected' }, ORIGIN));
  } else if (msg.type === 'ooj:disconnect') {
    chrome.storage.local.remove('token');
  }
});
