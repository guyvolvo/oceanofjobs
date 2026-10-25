// Product update emails: the owner's Markdown made into a plain, safe email,
// with the unsubscribe link every one of them carries. The link is the same
// signed one the alerts use (api/unsubscribe_token.py over the member's
// #email row), so api/handler.py's route turns the newsletter off with one
// click and no sign-in, and the List-Unsubscribe headers make it one click
// in Gmail and Yahoo too (RFC 8058).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SITE = "https://oceanofjobs.com";

// Markdown, the small part of it an update needs: headings, paragraphs,
// lists, bold, italics, links and inline code. Everything is escaped
// first; only links to http(s) or mailto survive.
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = url.replace(/&amp;/g, "&");
      return /^(https?:|mailto:)/i.test(u) ? `<a href="${esc(u)}" style="color:#3f6f45">${label}</a>` : label;
    });
}
export function markdown(md) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p style="margin:0 0 14px">${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<ul style="margin:0 0 14px;padding-left:20px">${list.map((li) => `<li style="margin:0 0 6px">${inline(li)}</li>`).join("")}</ul>`); list = null; };
  for (const raw of String(md || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) {
      flushPara(); flushList();
      const size = [0, 22, 18, 16][h[1].length];
      out.push(`<h${h[1].length} style="margin:18px 0 10px;font-size:${size}px;line-height:1.3">${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (li) { flushPara(); (list ||= []).push(li[1]); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

// The plain-text twin, for clients that don't show HTML.
export function text(md) {
  return String(md || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)").replace(/`/g, "");
}

// api/unsubscribe_token.py: the first 32 hex of HMAC-SHA256 over "<user>\n<row>".
export async function unsubscribeToken(secret, userId, row = "#email") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${userId}\n${row}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export async function unsubscribeUrl(env, userId) {
  const t = await unsubscribeToken(env.UNSUBSCRIBE_SECRET, userId);
  return `${SITE}/api/alerts/unsubscribe?u=${encodeURIComponent(userId)}&a=${encodeURIComponent("#email")}&t=${t}`;
}

// image: "" or undefined for the default painting, "none" for no image, or
// an image the owner picked and cropped (on the site, under /mail/).
export function headerImage(image) {
  if (image === "none") return "";
  const src = typeof image === "string" && image.startsWith(SITE + "/mail/") ? image : `${SITE}/img/email-header.jpg`;
  return `<tr><td style="padding:8px 28px 4px"><img src="${esc(src)}" width="544" alt="" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:10px"></td></tr>\n`;
}

export function page(subject, bodyHtml, unsubscribe, footerAddress = "", kind = "newsletter", image = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f0ef">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f0ef"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px">
<tr><td style="padding:24px 28px 8px;font:600 16px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#2b3328">Ocean of Jobs</td></tr>
${headerImage(image)}<tr><td style="padding:8px 28px 20px;font:400 15px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#2b3328">${bodyHtml}</td></tr>
</table>
<p style="max-width:600px;margin:16px auto 0;font:400 12px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#6b7266">
${kind === "account" ? `You're getting this because of your Ocean of Jobs account. Manage your emails in your <a href="${SITE}/account#settings" style="color:#6b7266">account settings</a>.`
  : `You're getting this because you subscribed to product updates from Ocean of Jobs.
<a href="${esc(unsubscribe)}" style="color:#6b7266">Unsubscribe</a> or change it in your <a href="${SITE}/account#settings" style="color:#6b7266">account settings</a>.`}${footerAddress ? `<br>${esc(footerAddress)}` : ""}</p>
</td></tr></table></body></html>`;
}

// A reply to a message someone sent to info@: a plain conversational
// email, no newsletter card or unsubscribe footer, threaded under theirs.
export function reply(env, { to, subject, md, inReplyTo = "", references = "" }) {
  const thread = inReplyTo ? [{ Name: "In-Reply-To", Value: inReplyTo }, { Name: "References", Value: `${references} ${inReplyTo}`.trim().slice(-900) }] : [];
  return {
    FromEmailAddress: env.MAIL_FROM || "Ocean of Jobs <info@oceanofjobs.com>",
    Destination: { ToAddresses: [to] },
    ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
    Content: { Simple: {
      Subject: { Data: /^re:/i.test(subject) ? subject : `Re: ${subject || "your message"}`, Charset: "UTF-8" },
      Body: {
        Html: { Data: `<div style="font:400 15px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#2b3328">${markdown(md)}</div>`, Charset: "UTF-8" },
        Text: { Data: text(md), Charset: "UTF-8" },
      },
      ...(thread.length ? { Headers: thread } : {}),
    } },
  };
}

// One SES v2 message for one member.
// kind "account": about the member's own account, so no unsubscribe from
// product updates (it would unsubscribe them from something else).
export async function message(env, { to, userId, subject, md, kind = "newsletter", image = "" }) {
  if (kind === "account") {
    return {
      FromEmailAddress: env.MAIL_FROM || "Ocean of Jobs <info@oceanofjobs.com>",
      Destination: { ToAddresses: [to] },
      ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
      Content: { Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: page(subject, markdown(md), "", env.MAIL_FOOTER_ADDRESS, "account", image), Charset: "UTF-8" },
          Text: { Data: `${text(md)}\n\nAccount settings: ${SITE}/account#settings`, Charset: "UTF-8" },
        },
      } },
    };
  }
  const unsubscribe = await unsubscribeUrl(env, userId);
  return {
    FromEmailAddress: env.MAIL_FROM || "Ocean of Jobs <info@oceanofjobs.com>",
    Destination: { ToAddresses: [to] },
    ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined,
    Content: { Simple: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: page(subject, markdown(md), unsubscribe, env.MAIL_FOOTER_ADDRESS, "newsletter", image), Charset: "UTF-8" },
        Text: { Data: `${text(md)}\n\nUnsubscribe: ${unsubscribe}\nAccount settings: ${SITE}/account#settings`, Charset: "UTF-8" },
      },
      Headers: [
        { Name: "List-Unsubscribe", Value: `<${unsubscribe}>` },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ],
    } },
  };
}
