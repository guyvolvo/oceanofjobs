// Contact sheets from _ext_ui_tour.mjs's shots: one image per surface and
// theme, each shot labelled, for reading on a phone.
//   node tests/e2e/_ext_ui_sheets.mjs <tour dir>
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png") && !f.startsWith("sheet-"));
const label = (f) => f.replace(/^(popup|card|settings)-/, "").replace(/-(dark|light)\.png$/, "").replace(/^\d+-/, (n) => `${parseInt(n)}. `).replace(/-/g, " ");
const SURFACES = [["popup", "Popup", 330], ["card", "Fill card on a page", 390], ["settings", "Settings page", 560]];
const browser = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  for (const [key, title, w] of SURFACES) {
    const shots = files.filter((f) => f.startsWith(key + "-") && f.endsWith(`-${scheme}.png`) && !f.includes("on-a-careers-page")).sort();
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 28px; background: ${scheme === "dark" ? "#050506" : "#dedad5"}; color: ${scheme === "dark" ? "#f2f0ef" : "#2b3328"}; font: 15px system-ui; }
      h1 { margin: 0 0 20px; font-size: 22px; font-weight: 600; }
      .grid { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }
      figure { margin: 0; width: ${w}px; } img { width: 100%; display: block; border-radius: 8px; outline: 1px solid ${scheme === "dark" ? "#2a2b30" : "#b9b4ad"}; }
      figcaption { margin-top: 8px; font-size: 14px; font-weight: 600; }</style>
      <h1>${title} · v${process.env.VER || ""} · ${scheme}</h1><div class="grid">${shots.map((f) => `<figure><img src="${f}"><figcaption>${label(f)}</figcaption></figure>`).join("")}</div>`;
    const file = path.join(dir, `_sheet-${key}-${scheme}.html`);
    fs.writeFileSync(file, html);
    const page = await browser.newPage({ viewport: { width: key === "settings" ? 1240 : 1860, height: 600 } });
    await page.goto(pathToFileURL(file).href);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(dir, `sheet-${key}-${scheme}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
console.log("sheets done");
