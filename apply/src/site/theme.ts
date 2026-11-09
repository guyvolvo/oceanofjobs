// The theme, one key for every page (iljobs_theme). <html data-theme>
// is what the old pages and the server-rendered /job pages read, and
// the React pages read data-mode; both are set together. Each page's head script
// applies the stored choice before first paint.
import { useEffect, useState } from "react";

export const isDark = () => document.documentElement.getAttribute("data-mode") === "dark";

export function applyTheme(dark: boolean) {
  const root = document.documentElement;
  root.setAttribute("data-mode", dark ? "dark" : "light");
  if (dark) root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("iljobs_theme", dark ? "dark" : "light"); } catch { /* storage blocked */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#17181c" : "#f2f0ef");
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(isDark()));
    watch.observe(document.documentElement, { attributeFilter: ["data-mode"] });
    return () => watch.disconnect();
  }, []);
  return [dark, () => applyTheme(!isDark())];
}
