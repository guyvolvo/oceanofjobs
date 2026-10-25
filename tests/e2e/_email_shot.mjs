import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const { message } = await import("file:///C:/Users/admin/Desktop/Test%20scripts/crm/lib/mail.mjs");
const m = await message({ UNSUBSCRIBE_SECRET: "s" }, { to: "a@example.com", userId: "u", subject: "Hello all ocean of jobs users", md: "## Hello all ocean of jobs users\n\nthis is a test of the new newsletter system! not spam..." });
const img = "data:image/jpeg;base64," + readFileSync("C:/Users/admin/Desktop/Test scripts/frontend/img/email-header.jpg").toString("base64");
const html = m.Content.Simple.Body.Html.Data.replace("https://oceanofjobs.com/img/email-header.jpg", img);
const b = await chromium.launch();
for (const [w, name] of [[760, "desktop"], [390, "phone"]]) {
  const p = await b.newPage({ viewport: { width: w, height: 600 }, deviceScaleFactor: 2 });
  await p.setContent(html);
  await p.screenshot({ path: `${process.argv[2]}/email-${name}.png`, fullPage: true });
}
await b.close();
