import { useEffect, useState } from "react";

// The site header (outside React) switches the theme on <html data-theme>;
// Kumo reads data-mode. One follows the other. Shared by /apply and /account.
export function useSiteTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => { root.dataset.mode = root.getAttribute("data-theme") === "dark" ? "dark" : "light"; };
    sync();
    const watch = new MutationObserver(sync);
    watch.observe(root, { attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
}

// Whether the page is dark right now, for code that needs real colours
// (the charts draw on a canvas, which can't read CSS variables).
export function useDark(): boolean {
  const read = () => document.documentElement.getAttribute("data-theme") === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(read()));
    watch.observe(document.documentElement, { attributeFilter: ["data-theme", "data-mode"] });
    return () => watch.disconnect();
  }, []);
  return dark;
}
