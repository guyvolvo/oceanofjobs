// Just enough MIME to read an email sent to info@: the text a person
// wrote, from a plain or multipart message, in base64 or quoted-printable,
// in its own charset. HTML-only messages are reduced to text. Attachments
// are counted, not kept. shortcut: no S/MIME, no TNEF, no nested
// message/rfc822 bodies; if one arrives, its text shows as the raw part.

const bytesOf = (bin) => Uint8Array.from(bin, (c) => c.charCodeAt(0) & 0xff);
function decodeText(bin, charset = "utf-8") {
  try { return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytesOf(bin)); }
  catch { return new TextDecoder("utf-8").decode(bytesOf(bin)); }
}
const qp = (s) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const b64 = (s) => { try { return atob(s.replace(/[^A-Za-z0-9+/=]/g, "")); } catch { return ""; } };

// "=?utf-8?B?...?=" and "=?utf-8?Q?...?=" words in a header.
export function decodeWords(v = "") {
  return String(v).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, enc, data) =>
    decodeText(enc.toUpperCase() === "B" ? b64(data) : qp(data.replace(/_/g, " ")), cs));
}

function split(raw) {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}
const param = (v = "", name) => {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(v);
  return m ? m[1] ?? m[2] : "";
};

export function htmlToText(html) {
  return html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}

// Walks the parts: the first text/plain wins, else the first text/html.
function walk(part, found) {
  const type = (part.headers["content-type"] || "text/plain").toLowerCase();
  const disposition = (part.headers["content-disposition"] || "").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(part.headers["content-type"], "boundary");
    if (!boundary) return;
    const pieces = part.body.split("--" + boundary);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      walk(split(piece.replace(/^\r?\n/, "")), found);
    }
    return;
  }
  if (disposition.startsWith("attachment") || !type.startsWith("text/")) { found.attachments++; return; }
  const enc = (part.headers["content-transfer-encoding"] || "").toLowerCase();
  const bin = enc === "base64" ? b64(part.body) : enc === "quoted-printable" ? qp(part.body) : part.body;
  const text = decodeText(bin, param(part.headers["content-type"], "charset") || "utf-8");
  if (type.startsWith("text/plain") && found.text === null) found.text = text;
  else if (type.startsWith("text/html") && found.html === null) found.html = text;
}

// raw: the message as a binary string (one char per byte).
export function readMessage(raw) {
  const found = { text: null, html: null, attachments: 0 };
  walk(split(raw), found);
  const text = found.text !== null ? found.text : found.html !== null ? htmlToText(found.html) : "";
  return { text: text.replace(/\r\n/g, "\n").trim(), attachments: found.attachments };
}

// "Dana Levi <dana@example.com>" -> { name, email }
export function address(v = "") {
  const s = decodeWords(v);
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(s);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: "", email: s.trim().toLowerCase() };
}
