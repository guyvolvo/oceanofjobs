// The image under "Ocean of Jobs" in an email: the default painting, none,
// or one the owner picks and crops to the header's shape (552x140, saved
// at twice that for sharp screens) and the CRM stores on the site.
import { useEffect, useRef, useState } from "react";
import { crm } from "./api";
import { toast } from "sonner";
import { X } from "@/components/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Btn, Loading } from "./ui";

const W = 1104, H = 280; // twice the email's 552x140
const DEFAULT = "https://oceanofjobs.com/img/email-header.jpg";

function Cropper({ src, onCancel, onDone }: { src: string; onCancel: () => void; onDone: (url: string) => void }) {
  const img = useRef<HTMLImageElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 }); // the crop's centre, as a share of the image
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; pos: { x: number; y: number } } | null>(null);
  // The crop in image pixels: the header's shape, as large as fits at zoom 1.
  const crop = () => {
    if (!size) return { cw: 0, ch: 0, cx: 0, cy: 0 };
    const base = Math.min(size.w, size.h * (W / H));
    const cw = base / zoom, ch = cw * (H / W);
    const cx = Math.min(Math.max(pos.x * size.w - cw / 2, 0), size.w - cw);
    const cy = Math.min(Math.max(pos.y * size.h - ch / 2, 0), size.h - ch);
    return { cw, ch, cx, cy };
  };
  const { cw, ch, cx, cy } = crop();
  const view = box.current ? box.current.clientWidth : 560;
  const scale = cw ? view / cw : 1;
  const down = (e: React.PointerEvent) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, pos }; };
  const move = (e: React.PointerEvent) => {
    if (!drag.current || !size) return;
    const dx = (e.clientX - drag.current.x) / scale / size.w, dy = (e.clientY - drag.current.y) / scale / size.h;
    setPos({ x: Math.min(1, Math.max(0, drag.current.pos.x - dx)), y: Math.min(1, Math.max(0, drag.current.pos.y - dy)) });
  };
  const use = async () => {
    if (!img.current) return;
    setBusy(true);
    try {
      const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
      canvas.getContext("2d")!.drawImage(img.current, cx, cy, cw, ch, 0, 0, W, H);
      const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      onDone((await crm<{ url: string }>("/images", "POST", { data })).url);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't save the image. Try again.");
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-[calc(100vh-48px)] overflow-y-auto sm:max-w-[640px]">
        <DialogTitle className="crm-card-title">Crop the image</DialogTitle>
        <p className="crm-note">Drag to move it. The frame is the email's header size.</p>
        <div ref={box} className="crm-crop" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
          <img ref={img} src={src} alt="" draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={size ? { width: size.w * scale, height: size.h * scale, transform: `translate(${-cx * scale}px, ${-cy * scale}px)` } : { visibility: "hidden" }} />
        </div>
        <label className="crm-zoom">Zoom
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <div className="crm-row" >
          <Btn loading={busy} disabled={!size} onClick={use}>Use this crop</Btn>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Saved = { sk: string; url: string };

export function ImagePicker({ value, onChange, disabled }: { value?: string; onChange: (v: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState("");
  const [saved, setSaved] = useState<Saved[] | null>(null);
  useEffect(() => { crm<{ images: Saved[] }>("/images").then((r) => setSaved(r.images), () => setSaved([])); }, []);
  const pick = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Choose an image file.");
    if (file.size > 20 * 1024 * 1024) return toast.error("Choose an image under 20 MB.");
    const r = new FileReader();
    r.onload = () => setSrc(String(r.result));
    r.readAsDataURL(file);
    if (input.current) input.current.value = "";
  };
  const forget = async (img: Saved) => {
    await crm(`/images/${encodeURIComponent(img.sk)}`, "DELETE").then(() => setSaved((s) => (s || []).filter((x) => x.sk !== img.sk)),
      (e) => toast.error(e.message));
    if (value === img.url) onChange("");
  };
  const current = value === "none" ? "none" : value || "";
  const tile = (key: string, on: boolean, label: string, child: React.ReactNode, act: () => void, extra?: React.ReactNode) => (
    <div key={key} className={`crm-pick${on ? " on" : ""}`}>
      <button type="button" disabled={disabled} aria-pressed={on} aria-label={label} onClick={act}>{child}</button>
      {extra}
    </div>
  );
  return (
    <div className="crm-stack">
      <span className="crm-label">Header image</span>
      <div className="crm-picks">
        {tile("default", current === "", "The sea painting", <img src={DEFAULT} alt="" />, () => onChange(""))}
        {(saved || []).map((img) => tile(img.sk, current === img.url, "A saved image", <img src={img.url} alt="" />, () => onChange(img.url),
          <button type="button" className="crm-pick-x" disabled={disabled} aria-label="Remove from the list" onClick={() => forget(img)}><X /></button>))}
        {tile("none", current === "none", "No image", <span>No image</span>, () => onChange("none"))}
        {tile("upload", false, "Upload and crop an image", <span>+ Upload</span>, () => input.current?.click())}
      </div>
      {saved === null ? <Loading>Loading your images</Loading> : null}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {src ? <Cropper src={src} onCancel={() => setSrc("")} onDone={(url) => {
        setSrc(""); onChange(url); setSaved((s) => [{ sk: new Date().toISOString(), url }, ...(s || [])]);
      }} /> : null}
    </div>
  );
}
