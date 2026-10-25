// The image under "Ocean of Jobs" in an email: the default painting, none,
// or one the owner picks and crops to the header's shape (552x140, saved
// at twice that for sharp screens) and the CRM stores on the site.
import { useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { crm } from "./api";

const W = 1104, H = 280; // twice the email's 552x140
const DEFAULT = "https://oceanofjobs.com/img/email-header.jpg";

function Cropper({ src, onCancel, onDone }: { src: string; onCancel: () => void; onDone: (url: string) => void }) {
  const toasts = useKumoToastManager();
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
      toasts.add({ variant: "error", title: (e as Error).message || "Couldn't save the image. Try again." });
    } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <Dialog className="crm-dialog">
        <Dialog.Title className="crm-card-title">Crop the image</Dialog.Title>
        <p className="crm-note">Drag to move it. The frame is the email's header size.</p>
        <div ref={box} className="crm-crop" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
          <img ref={img} src={src} alt="" draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={size ? { width: size.w * scale, height: size.h * scale, transform: `translate(${-cx * scale}px, ${-cy * scale}px)` } : { visibility: "hidden" }} />
        </div>
        <label className="crm-zoom">Zoom
          <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <div className="crm-row" style={{ marginTop: 16 }}>
          <Button variant="primary" loading={busy} disabled={!size} onClick={use}>Use this crop</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function ImagePicker({ value, onChange, disabled }: { value?: string; onChange: (v: string) => void; disabled?: boolean }) {
  const toasts = useKumoToastManager();
  const input = useRef<HTMLInputElement>(null);
  const [src, setSrc] = useState("");
  const pick = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toasts.add({ variant: "error", title: "Choose an image file." });
    if (file.size > 20 * 1024 * 1024) return toasts.add({ variant: "error", title: "Choose an image under 20 MB." });
    const r = new FileReader();
    r.onload = () => setSrc(String(r.result));
    r.readAsDataURL(file);
    if (input.current) input.current.value = "";
  };
  const shown = value === "none" ? "" : value || DEFAULT;
  return (
    <div className="crm-stack">
      <span className="crm-label">Header image</span>
      {shown ? <img className="crm-header-img" src={shown} alt="" /> : <p className="crm-note">No image in this email.</p>}
      <div className="crm-row">
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => input.current?.click()}>Choose an image</Button>
        {value && value !== "none" ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange("")}>Use the default</Button> : null}
        {value !== "none" ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange("none")}>No image</Button>
          : <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange("")}>Use the default</Button>}
      </div>
      {src ? <Cropper src={src} onCancel={() => setSrc("")} onDone={(url) => { setSrc(""); onChange(url); }} /> : null}
    </div>
  );
}
