// A rendered job page (frontend/_preview_job_seo.html, written from api/job_page.py with sample data), full length.
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1.25 });
await p.goto("http://localhost:8023/_preview_job_seo.html");
await p.waitForTimeout(1500);
await p.screenshot({ path: process.argv[2], fullPage: true });
await b.close();
