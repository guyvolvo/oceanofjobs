// The Social page's types and calls (crm/lib/social.mjs on the Worker).
import { InstagramLogo, LinkedinLogo, TiktokLogo, type Icon } from "@/components/icons";
import { CrmError } from "../api";

export type Network = "instagram" | "linkedin" | "tiktok";
export const NETWORKS: Network[] = ["instagram", "linkedin", "tiktok"];
export const NET: Record<Network, { name: string; icon: Icon; limit: number }> = {
  instagram: { name: "Instagram", icon: InstagramLogo, limit: 2200 },
  linkedin: { name: "LinkedIn", icon: LinkedinLogo, limit: 3000 },
  tiktok: { name: "TikTok", icon: TiktokLogo, limit: 4000 },
};

export type Account = { network: Network; ready: boolean; connected: boolean; name: string; handle: string; picture: string;
  followers: number | null; expires: string; refresh_expires: string; connected_at: string; error: string };
export type Media = { url: string; type: "image" | "video"; mime: string; bytes: number; w?: number; h?: number };
export type Result = { state: "queued" | "processing" | "posted" | "inbox" | "failed"; error?: string; url?: string; id?: string; at?: string };
export type Status = "draft" | "scheduled" | "publishing" | "done" | "partial" | "failed";
export type Post = { sk: string; title: string; caption: string; captions: Partial<Record<Network, string>>; media: Media[]; networks: Network[];
  at: string; created: string; updated: string; status: Status; results: Partial<Record<Network, Result>>; published_at?: string };

export const STATUS: Record<Status, string> = { draft: "Draft", scheduled: "Scheduled", publishing: "Sending", done: "Posted", partial: "Partly posted", failed: "Failed" };
export const RESULT: Record<Result["state"], string> = { queued: "Waiting", processing: "Processing", posted: "Posted", inbox: "In TikTok drafts", failed: "Failed" };

// The file goes to the Worker as it is (no JSON), which streams it to the site.
export async function uploadFile(file: Blob, type = file.type): Promise<Media> {
  const res = await fetch("/api/social/media", { method: "POST", credentials: "same-origin", headers: { "X-CRM": "1", "Content-Type": type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CrmError((data as { error?: string }).error || `HTTP ${res.status}`, res.status);
  return data as Media;
}

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
// The time a post belongs to on the planner: when it went out, or when it's due.
export const postTime = (p: Post) => p.published_at || p.at || p.created;
export const postKey = (sk: string) => encodeURIComponent(sk);
