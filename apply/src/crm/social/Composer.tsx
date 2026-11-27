// Writing a post: networks, text (one for all or one per network), media
// (uploaded, or made in the Studio), then post now, schedule or keep as a
// draft. After "Post now" the page moves each network on until it's done.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ArrowRight, Copy, ImageSquare, UploadSimple, X } from "@/components/icons";
import { crm } from "../api";
import { AreaField, Btn, Panel, SwitchField, TextField } from "../ui";
import { NET, NETWORKS, RESULT, uploadFile, type Account, type Media, type Network, type Post } from "./data";
import { Studio } from "./Studio";

type Mode = "now" | "schedule" | "draft";
const IG_RATIO: [number, number] = [4 / 5, 1.91]; // the shapes Instagram's feed accepts

// What each network takes, the same rules as check() in crm/lib/social.mjs.
export function problems(networks: Network[], media: Media[], text: (n: Network) => string) {
  const out: string[] = [];
  const videos = media.filter((m) => m.type === "video").length;
  for (const n of networks) {
    if (text(n).length > NET[n].limit) out.push(`${NET[n].name} takes up to ${NET[n].limit.toLocaleString()} characters.`);
    if (n === "instagram" && !media.length) out.push("Instagram needs an image or a video.");
    if (n === "instagram" && media.length > 10) out.push("Instagram takes up to 10 images or videos in one post.");
    if (n === "instagram" && (text(n).match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) out.push("Instagram takes up to 30 hashtags.");
    if (n === "linkedin" && videos && media.length > 1) out.push("LinkedIn takes one video on its own, or up to 20 images.");
    if (n === "linkedin" && !media.length && !text(n).trim()) out.push("Write something for LinkedIn.");
    if (n === "tiktok" && !media.length) out.push("TikTok needs a video or photos.");
    if (n === "tiktok" && videos && media.length > 1) out.push("TikTok takes one video, or up to 35 photos.");
  }
  return out;
}

// An image the networks will take: JPEG, under 8 MB, and for Instagram
// within its shapes (cropped from the middle when it isn't).
async function prepareImage(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const img = await createImageBitmap(file);
  let { width: w, height: h } = img;
  let sx = 0, sy = 0, sw = w, sh = h;
  const r = w / h;
  if (r < IG_RATIO[0]) { sh = Math.round(w / IG_RATIO[0]); sy = Math.round((h - sh) / 2); }
  if (r > IG_RATIO[1]) { sw = Math.round(h * IG_RATIO[1]); sx = Math.round((w - sw) / 2); }
  const scale = Math.min(1, 2160 / Math.max(sw, sh));
  w = Math.round(sw * scale); h = Math.round(sh * scale);
  const fine = file.type === "image/jpeg" && file.size <= 8e6 && sx === 0 && sy === 0 && sw === img.width && sh === img.height && scale === 1;
  if (fine) return { blob: file, w, h };
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
  if (!blob) throw new Error("Couldn't read that image.");
  return { blob, w, h };
}

const localTime = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
};

export function Composer({ accounts, initial, onDone }: { accounts: Account[]; initial: Post | null; onDone: () => void }) {
  const connected = accounts.filter((a) => a.connected).map((a) => a.network);
  const [networks, setNetworks] = useState<Network[]>(initial ? initial.networks : connected);
  const [caption, setCaption] = useState(initial?.caption || "");
  const [split, setSplit] = useState(!!initial && Object.keys(initial.captions || {}).length > 0);
  const [captions, setCaptions] = useState<Partial<Record<Network, string>>>(initial?.captions || {});
  const [media, setMedia] = useState<Media[]>(initial?.media || []);
  const [mode, setMode] = useState<Mode>(initial?.at ? "schedule" : "now");
  const [at, setAt] = useState(initial?.at ? localTime(initial.at) : localTime(new Date(Date.now() + 3600e3).toISOString()));
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [studio, setStudio] = useState(false);
  const [sending, setSending] = useState<Post | null>(null);
  const [preview, setPreview] = useState<Network>(networks[0] || "instagram");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!networks.includes(preview) && networks.length) setPreview(networks[0]); }, [networks, preview]);

  const text = (n: Network) => (split && captions[n] !== undefined ? captions[n] || "" : caption);
  const issues = problems(networks, media, text);
  const toggle = (n: Network) => setNetworks((x) => (x.includes(n) ? x.filter((y) => y !== n) : [...x, n]));

  const add = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        if (f.type.startsWith("video/")) {
          if (!["video/mp4", "video/quicktime"].includes(f.type)) throw new Error("Videos must be MP4 or MOV.");
          if (f.size > 64 * 1024 * 1024) throw new Error(`${f.name} is over 64 MB.`);
          const m = await uploadFile(f);
          setMedia((x) => [...x, m]);
        } else if (f.type.startsWith("image/")) {
          const { blob, w, h } = await prepareImage(f);
          const m = await uploadFile(blob, "image/jpeg");
          setMedia((x) => [...x, { ...m, w, h }]);
        } else throw new Error(`${f.name} isn't an image or a video.`);
      } catch (e) { toast.error((e as Error).message); } finally { setUploading((n) => n - 1); }
    }
    if (file.current) file.current.value = "";
  };
  const move = (i: number, by: number) => setMedia((x) => { const y = [...x]; const [m] = y.splice(i, 1); y.splice(i + by, 0, m); return y; });

  // Moves the post on, one network at a time, until every network is done or the page gives up (the cron carries on).
  const follow = async (post: Post) => {
    let p = post;
    for (let round = 0; round < 60 && p.status === "publishing"; round++) {
      for (const n of p.networks) {
        const r = p.results[n];
        if (r && (r.state === "queued" || r.state === "processing")) {
          p = (await crm<{ post: Post }>(`/social/posts/${encodeURIComponent(p.sk)}/advance?network=${n}`, "POST")).post;
          setSending(p);
        }
      }
      if (p.status === "publishing") await new Promise((ok) => setTimeout(ok, 5000));
    }
    return p;
  };

  const save = async (m: Mode) => {
    setBusy(true);
    try {
      const body = { sk: initial?.sk, mode: m, networks, caption, captions: split ? captions : {}, media, at: m === "schedule" ? new Date(at).toISOString() : "" };
      const { post } = await crm<{ post: Post }>("/social/posts", "POST", body);
      if (m === "draft") { toast.success("Draft saved"); onDone(); return; }
      if (m === "schedule") { toast.success(`Scheduled for ${new Date(post.at).toLocaleString()}`); onDone(); return; }
      setSending(post);
      const done = await follow(post);
      if (done.status === "done") toast.success("Posted");
      else if (done.status === "publishing") toast("Still processing. It finishes on its own, check Posts in a few minutes.");
      else toast.error(done.status === "partial" ? "Some networks didn't take it. See Posts for why." : "Nothing went out. See Posts for why.");
      onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const hasVideo = media.some((m) => m.type === "video");
  const canGo = networks.length > 0 && !issues.length && !uploading;
  return (
    <div className="soc-compose">
      <div className="crm-stack">
        <Panel><div className="crm-card crm-stack">
          <div>
            <h2>Post to</h2>
            <div className="soc-nets">
              {NETWORKS.map((n) => {
                const Icon = NET[n].icon;
                const on = networks.includes(n), ok = connected.includes(n);
                return (
                  <button key={n} type="button" className="soc-net" aria-pressed={on} disabled={!ok} onClick={() => toggle(n)}>
                    <Icon size={18} />{NET[n].name}{!ok ? <span className="crm-sub">Not connected</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <SwitchField label="Different text for each network" checked={split} onClick={() => setSplit(!split)} />
          {!split ? (
            <AreaField label="Text" className="min-h-40" value={caption} onChange={(e) => setCaption(e.target.value)}
              description={`${caption.length.toLocaleString()} characters${networks.length ? `. ${networks.map((n) => `${NET[n].name} takes ${NET[n].limit.toLocaleString()}`).join(", ")}.` : ""}`} />
          ) : networks.map((n) => (
            <AreaField key={n} label={NET[n].name} className="min-h-32" value={captions[n] ?? caption} onChange={(e) => setCaptions({ ...captions, [n]: e.target.value })}
              description={`${text(n).length.toLocaleString()} of ${NET[n].limit.toLocaleString()} characters`} />
          ))}
          {networks.includes("tiktok") && hasVideo ? (
            <div className="soc-hint">
              <span>TikTok gets the video in your drafts without the text. Paste it in the app before you post.</span>
              <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(text("tiktok")).then(() => toast.success("Text copied"))}><Copy />Copy text</Button>
            </div>
          ) : networks.includes("tiktok") && media.length ? <p className="crm-note">TikTok gets the photos in your drafts. You post them from the app.</p> : null}
        </div></Panel>

        <Panel><div className="crm-card crm-stack">
          <div className="crm-row between">
            <h2>Images and video</h2>
            <div className="crm-row">
              <Button variant="outline" onClick={() => setStudio(true)}><ImageSquare />Make an image</Button>
              <Btn variant="outline" loading={uploading > 0} onClick={() => file.current?.click()}><UploadSimple />Upload</Btn>
              <input ref={file} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={(e) => add(e.target.files)} />
            </div>
          </div>
          {media.length ? (
            <div className="soc-media">
              {media.map((m, i) => (
                <figure key={m.url} className="soc-thumb">
                  {m.type === "video" ? <video src={m.url} muted preload="metadata" /> : <img src={m.url} alt="" />}
                  <figcaption>
                    <Button variant="ghost" size="icon" aria-label="Move left" disabled={!i} onClick={() => move(i, -1)}><ArrowLeft /></Button>
                    <span>{i + 1}</span>
                    <Button variant="ghost" size="icon" aria-label="Move right" disabled={i === media.length - 1} onClick={() => move(i, 1)}><ArrowRight /></Button>
                    <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setMedia(media.filter((_, j) => j !== i))}><X /></Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <button type="button" className="soc-drop" onClick={() => file.current?.click()} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files); }}>
              Drop images or a video here, or click to pick them. Images up to 8 MB, videos up to 64 MB.
            </button>
          )}
          {uploading ? <p className="crm-note">Uploading {uploading} file{uploading === 1 ? "" : "s"}</p> : null}
        </div></Panel>

        <Panel><div className="crm-card crm-stack">
          <h2>When</h2>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} className="soc-when">
            {([["now", "Post now"], ["schedule", "Schedule"], ["draft", "Save as draft"]] as [Mode, string][]).map(([v, l]) => (
              <div key={v} className="flex items-center gap-2"><RadioGroupItem id={`when-${v}`} value={v} /><Label htmlFor={`when-${v}`} className="font-normal">{l}</Label></div>
            ))}
          </RadioGroup>
          {mode === "schedule" ? (
            <div className="crm-row">
              <TextField label="Date and time" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              <p className="crm-note">Goes out within 5 minutes of this time, your time zone.</p>
            </div>
          ) : null}
          {issues.length && mode !== "draft" ? <ul className="soc-issues">{issues.map((x) => <li key={x}>{x}</li>)}</ul> : null}
          {sending ? (
            <ul className="soc-progress">
              {sending.networks.map((n) => <li key={n}><b>{NET[n].name}</b> {RESULT[sending.results[n]?.state || "queued"]}{sending.results[n]?.error ? `: ${sending.results[n]!.error}` : ""}</li>)}
            </ul>
          ) : null}
          <div className="crm-row">
            <Btn loading={busy} disabled={mode !== "draft" && !canGo} onClick={() => save(mode)}>
              {mode === "now" ? "Post now" : mode === "schedule" ? "Schedule" : "Save draft"}
            </Btn>
            {initial ? <Button variant="ghost" onClick={onDone}>Cancel</Button> : null}
          </div>
        </div></Panel>
      </div>

      <div className="soc-preview-col">
        {networks.length ? (
          <Tabs value={preview} onValueChange={(v) => setPreview(v as Network)}>
            <TabsList aria-label="Preview">{networks.map((n) => <TabsTrigger key={n} value={n} className="px-3">{NET[n].name}</TabsTrigger>)}</TabsList>
          </Tabs>
        ) : null}
        <Preview network={preview} account={accounts.find((a) => a.network === preview)} text={text(preview)} media={media} />
      </div>

      <Dialog open={studio} onOpenChange={setStudio}>
        <DialogContent aria-describedby={undefined} className="max-h-[calc(100vh-32px)] overflow-y-auto sm:max-w-[min(1400px,calc(100vw-32px))]">
          <DialogTitle>Make an image</DialogTitle>
          <Studio onUse={(m) => { setMedia((x) => [...x, m]); setStudio(false); }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Roughly how the post looks on the network, to catch a cut-off caption or a bad crop.
function Preview({ network, account, text, media }: { network: Network; account?: Account; text: string; media: Media[] }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [media.length, network]);
  const m = media[Math.min(i, media.length - 1)];
  const who = account?.handle || account?.name || NET[network].name;
  const head = (
    <div className="soc-pv-head">
      {account?.picture ? <img src={account.picture} alt="" /> : <span className="soc-pv-avatar" />}
      <b>{who}</b>
    </div>
  );
  const shot = m ? (
    <div className={`soc-pv-media soc-pv-${network}`}>
      {m.type === "video" ? <video src={m.url} muted controls preload="metadata" /> : <img src={m.url} alt="" />}
      {media.length > 1 ? (
        <div className="soc-pv-dots">
          {media.map((x, j) => <button key={x.url} type="button" aria-label={`Show ${j + 1}`} aria-current={j === i} onClick={() => setI(j)} />)}
        </div>
      ) : null}
    </div>
  ) : <div className={`soc-pv-media soc-pv-${network} soc-pv-empty`}>No image yet</div>;
  const body = network === "instagram" && text.length > 125 ? <>{text.slice(0, 125)}<span className="crm-sub">… more</span></> : text;
  return (
    <Panel className="soc-preview"><div>
      {network === "linkedin" ? <>{head}<p className="soc-pv-text">{text.length > 210 ? <>{text.slice(0, 210)}<span className="crm-sub">…see more</span></> : text}</p>{m ? shot : null}</> : null}
      {network === "instagram" ? <>{head}{shot}<p className="soc-pv-text"><b>{who}</b> {body}</p></> : null}
      {network === "tiktok" ? <>{shot}<p className="soc-pv-text">{text.slice(0, 150)}{text.length > 150 ? "…" : ""}</p></> : null}
    </div></Panel>
  );
}
