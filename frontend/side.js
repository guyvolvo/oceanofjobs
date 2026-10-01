// The sidebar every app-shaped page has (the board, the companies
// directory): folds to a strip on a desktop, is a drawer behind the
// menu button below 1100px, and on a phone also holds the sign-in and
// theme controls the header has no room for. One implementation, called
// by each page's own script once its markup is there.
//
// closeSideDrawer is a global so a page's Escape handler can ask the
// drawer to go first. True when it was open.
let closeSideDrawer = () => false;

function wireSideBar() {
  const side = document.getElementById("site-side");
  if (!side) return;
  const FOLD_KEY = "iljobs_side_folded";
  const fold = document.getElementById("side-fold");
  const setFolded = (on) => {
    document.body.classList.toggle("side-folded", on);
    fold?.setAttribute("aria-expanded", String(!on));
    fold?.setAttribute("aria-label", on ? "Expand the sidebar" : "Collapse the sidebar");
    if (fold) fold.title = on ? "Expand" : "Collapse";
    try { localStorage.setItem(FOLD_KEY, on ? "1" : "0"); } catch { /* per-browser nicety only */ }
  };
  try { setFolded(localStorage.getItem(FOLD_KEY) === "1"); } catch { /* as above */ }
  fold?.addEventListener("click", () => setFolded(!document.body.classList.contains("side-folded")));

  const openBtn = document.getElementById("side-open");
  const setOpen = (on) => {
    document.body.classList.toggle("side-open", on);
    openBtn?.setAttribute("aria-expanded", String(on));
    if (on) side.querySelector("a, button")?.focus({ preventScroll: true });
    else openBtn?.focus({ preventScroll: true });
  };
  openBtn?.addEventListener("click", () => setOpen(!document.body.classList.contains("side-open")));
  document.getElementById("side-scrim")?.addEventListener("click", () => setOpen(false));
  // A pick in the drawer is the end of the visit to it.
  side.addEventListener("click", (e) => {
    if (e.target.closest(".side-cat, .seg-btn") && document.body.classList.contains("side-open")) setOpen(false);
  });
  closeSideDrawer = () => {
    if (!document.body.classList.contains("side-open")) return false;
    setOpen(false);
    return true;
  };

  // Sign-in and the theme switch: in the header's corner, or on a phone
  // in the drawer's foot. The same nodes either way, moved, so there is
  // one of each with its own listeners.
  const corner = document.querySelector(".board-corner");
  const foot = document.getElementById("side-account");
  const narrow = matchMedia("(max-width: 640px)");
  const place = () => {
    const home = narrow.matches ? foot : corner;
    if (!home) return;
    for (const el of [document.getElementById("auth-area"), document.querySelector(".dir-login"), document.getElementById("theme-toggle")]) {
      if (el && el.parentElement !== home) home.append(el);
    }
  };
  place();
  narrow.addEventListener("change", place);
}
