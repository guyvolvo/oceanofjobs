// Each deploy deletes the previous build's chunks (s3 sync --delete), so a tab
// opened before it fails to lazy-load one (sign-in, the menus). Reload once to
// get the new HTML; the timestamp stops a loop if the chunk is missing for good.
addEventListener("vite:preloadError", (e) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem("ooj_stale_reload")) < 30_000) return;
    sessionStorage.setItem("ooj_stale_reload", String(Date.now()));
  } catch { return; }
  e.preventDefault();
  location.reload();
});
