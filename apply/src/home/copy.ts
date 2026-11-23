// Shared by the API sample's Copy, the hero's install rows and the board's
// copy and share links. Calls done only once the text is on the
// clipboard. Clipboard needs a secure context, and this page is also
// served over plain http in local testing.
export function copyText(text: string, done: () => void) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { /* nothing copied */ }
  document.body.removeChild(ta);
}
