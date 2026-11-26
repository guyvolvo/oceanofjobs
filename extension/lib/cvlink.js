// A resume kept at a share link (Settings, Resume, Link). direct() turns a
// Drive, Docs, Dropbox or OneDrive share link into its download address;
// origins() lists the hosts Chrome must allow for it, the link's own and
// the ones its download redirects to, asked for on Save under the optional
// https://*/*. Loaded by background.js (importScripts), popup.html and
// options.html.
globalThis.oojCvLink = (() => {
  const parse = (link) => {
    try {
      const u = new URL(String(link || '').trim());
      return u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  };

  // The download address, or null for anything but an https link.
  function direct(link) {
    const u = parse(link);
    if (!u) return null;
    const host = u.hostname;
    if (host === 'drive.google.com') {
      const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get('id');
      return id ? `https://drive.google.com/uc?export=download&id=${id}` : u.href;
    }
    if (host === 'docs.google.com') {
      const id = (u.pathname.match(/\/document\/d\/([\w-]+)/) || [])[1];
      return id ? `https://docs.google.com/document/d/${id}/export?format=pdf` : u.href;
    }
    if (host === 'dropbox.com' || host === 'www.dropbox.com') {
      u.searchParams.set('dl', '1');
      return u.href;
    }
    // Older OneDrive links: redir and embed have a download twin. 1drv.ms
    // and newer links are tried as given.
    if (host === 'onedrive.live.com' && /^\/(redir|embed)$/.test(u.pathname)) {
      u.pathname = '/download';
      return u.href;
    }
    return u.href;
  }

  function origins(link) {
    const u = parse(link);
    if (!u) return [];
    const host = u.hostname;
    const extra = host === 'drive.google.com' ? ['drive.usercontent.google.com']
      : host === 'docs.google.com' ? ['*.googleusercontent.com']
        : host === 'dropbox.com' || host === 'www.dropbox.com' ? ['*.dropboxusercontent.com']
          : host === '1drv.ms' || host === 'onedrive.live.com' ? ['onedrive.live.com', '*.1drv.com']
            : [];
    return [host, ...extra].filter((h, i, all) => all.indexOf(h) === i).map((h) => `https://${h}/*`);
  }

  return { direct, origins };
})();
