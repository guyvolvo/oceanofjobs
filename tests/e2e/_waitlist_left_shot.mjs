// The Pro beta license counter, with the count stubbed: the homepage card and the pricing section.
//   node tests/e2e/_waitlist_left_shot.mjs <outdir> [taken]
import { chromium } from "playwright";
const taken = Number(process.argv[3] || 13);
const b = await chromium.launch();
for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1.5 });
  await p.route("**/api/waitlist", (r) => r.fulfill({ json: { pro: { cap: 100, taken }, basic: { cap: null } } }));
  await p.goto((process.env.BASE || "http://localhost:8023") + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  await p.locator(".home-promo").screenshot({ path: `${process.argv[2]}/wl-card-${name}-${taken}.png` });
  const pricing = name === "desktop" ? p.locator(".ptable tfoot") : p.locator(".pcard").last();
  await pricing.scrollIntoViewIfNeeded();
  await pricing.screenshot({ path: `${process.argv[2]}/wl-pricing-${name}-${taken}.png` });
  await p.close();
}
await b.close();
