// The homepage hero's waitlist line under the extension card, desktop and phone, dark and light.
import { chromium } from "playwright";
const b = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1.5 });
    await p.goto((process.env.BASE || "http://localhost:8023") + "/", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    const box = await p.locator(".home-hero-text").boundingBox();
    await p.screenshot({ path: `${process.argv[2]}/home-beta-${name}-${scheme}.png`, clip: { x: 0, y: Math.max(0, box.y), width: w, height: Math.min(box.height + 40, 900) } });
    if (name === "desktop" && scheme === "dark") {
      await p.locator(".home-beta").hover();
      await p.screenshot({ path: `${process.argv[2]}/home-beta-hover.png`, clip: { x: 0, y: Math.max(0, box.y), width: w, height: Math.min(box.height + 40, 900) } });
    }
    await p.close();
  }
}
await b.close();
