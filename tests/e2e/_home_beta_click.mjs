// Clicking the homepage's waitlist line while signed out: the sign-in window it opens.
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await p.goto((process.env.BASE || "http://localhost:8023") + "/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await p.locator(".home-beta").click();
await p.waitForTimeout(800);
await p.screenshot({ path: `${process.argv[2]}/home-beta-signin.png` });
await b.close();
