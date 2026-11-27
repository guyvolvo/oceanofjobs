// Numbers and comments: followers over time, Instagram's and TikTok's
// recent posts with their counts, and Instagram comments to answer.
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, ChatCircleDots, Eye, EyeSlash, Heart, Trash } from "@/components/icons";
import { crm } from "../api";
import { useLoad, Failed } from "../App";
import { Btn, Loading, Panel } from "../ui";
import { NET, type Account } from "./data";

const GrowthChart = lazy(() => import("../Charts").then((m) => ({ default: m.GrowthChart })));

type IgMedia = { id: string; caption?: string; media_type: string; media_url?: string; thumbnail_url?: string; permalink: string; timestamp: string; like_count?: number; comments_count?: number };
type TtVideo = { id: string; title?: string; video_description?: string; cover_image_url?: string; share_url?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; create_time?: number };
type Overview = { accounts: Account[]; followers: ({ sk: string } & Record<string, number | string>)[]; instagram?: IgMedia[]; instagram_error?: string; tiktok?: TtVideo[]; tiktok_error?: string };
const n = (v?: number | null) => (v === undefined || v === null ? "–" : v.toLocaleString());

export function Stats() {
  const { data, error, load } = useLoad<Overview>("/social/overview");
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <Loading>Loading numbers from the networks</Loading>;
  const on = data.accounts.filter((a) => a.connected);
  if (!on.length) return <Panel><div className="crm-card"><p className="crm-note">Connect an account on the Accounts tab to see its numbers here.</p></div></Panel>;
  // Followers per day for each network that reports them, from the daily count the cron keeps.
  const charts = on.filter((a) => a.network !== "linkedin").map((a) => ({ a, days: data.followers.filter((f) => f[a.network] !== undefined)
    .map((f) => [f.sk, Number(f[a.network])] as [string, number]) })).filter((c) => c.days.length > 1);
  return (
    <div className="crm-stack">
      <div className="crm-stats">
        {on.map((a) => (
          <Panel key={a.network}><div className="crm-stat">
            <b>{a.network === "linkedin" ? "–" : n(a.followers)}</b>
            <span>{NET[a.network].name} followers</span>
            <span className="crm-sub">{a.network === "linkedin" ? "LinkedIn doesn't share follower counts with apps like this one" : a.handle || a.name}</span>
          </div></Panel>
        ))}
      </div>
      {charts.length ? (
        <div className="crm-charts">
          {charts.map(({ a, days }) => (
            <Panel key={a.network}><div className="crm-card"><h2>{NET[a.network].name} followers</h2>
              <Suspense fallback={<Loading />}><GrowthChart buckets={days} label="Followers" /></Suspense>
              <p className="crm-note">Counted once a day.</p>
            </div></Panel>
          ))}
        </div>
      ) : null}
      {data.instagram_error ? <Failed error={data.instagram_error} retry={load} /> : null}
      {data.instagram ? (
        <Panel><div className="crm-card crm-stack"><h2>Instagram, latest posts</h2>
          <div className="soc-grid">
            {data.instagram.map((m) => (
              <a key={m.id} className="soc-tile" href={m.permalink} target="_blank" rel="noreferrer">
                <img src={m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url} alt="" loading="lazy" />
                <span className="soc-tile-n"><Heart size={14} />{n(m.like_count)} <ChatCircleDots size={14} />{n(m.comments_count)}</span>
                <span className="crm-sub">{new Date(m.timestamp).toLocaleDateString()}</span>
              </a>
            ))}
          </div>
          {!data.instagram.length ? <p className="crm-note">No posts on this account yet.</p> : null}
        </div></Panel>
      ) : null}
      {data.tiktok_error ? <Failed error={data.tiktok_error} retry={load} /> : null}
      {data.tiktok ? (
        <Panel><div className="crm-card crm-stack"><h2>TikTok, latest videos</h2>
          <div className="soc-grid">
            {data.tiktok.map((v) => (
              <a key={v.id} className="soc-tile" href={v.share_url} target="_blank" rel="noreferrer">
                <img src={v.cover_image_url} alt="" loading="lazy" />
                <span className="soc-tile-n"><Eye size={14} />{n(v.view_count)} <Heart size={14} />{n(v.like_count)} <ChatCircleDots size={14} />{n(v.comment_count)}</span>
                <span className="crm-sub">{v.create_time ? new Date(v.create_time * 1000).toLocaleDateString() : ""}</span>
              </a>
            ))}
          </div>
          {!data.tiktok.length ? <p className="crm-note">No videos yet. Videos sent to your drafts show here once you post them in the app.</p> : null}
        </div></Panel>
      ) : null}
      {on.some((a) => a.network === "linkedin") ? <p className="crm-note">LinkedIn doesn't give post numbers to apps without its partner approval. Check them on LinkedIn.</p> : null}
    </div>
  );
}

type Reply = { id: string; text: string; username: string; timestamp: string };
type Comment = Reply & { like_count?: number; hidden?: boolean; replies: Reply[] };
type WithComments = { id: string; caption: string; permalink: string; timestamp: string; thumb: string; count: number; comments: Comment[] };

export function Comments() {
  const { data, error, load, setData } = useLoad<{ media: WithComments[] }>("/social/comments");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  if (error) return <Failed error={error} retry={load} />;
  if (!data) return <Loading>Loading comments</Loading>;
  const act = async (c: Comment, op: string, message?: string) => {
    setBusy(c.id + op);
    try {
      await crm("/social/comments", "POST", { id: c.id, op, message });
      if (op === "reply") { setDraft({ ...draft, [c.id]: "" }); toast.success("Reply posted"); load(); }
      else setData({ media: data.media.map((m) => ({ ...m, comments: op === "delete" ? m.comments.filter((x) => x.id !== c.id) : m.comments.map((x) => (x.id === c.id ? { ...x, hidden: op === "hide" } : x)) })) });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  };
  const withComments = data.media.filter((m) => m.comments.length);
  return (
    <div className="crm-stack">
      <p className="crm-note">Comments on your 12 latest Instagram posts.</p>
      {!withComments.length ? <Panel><div className="crm-card"><p className="crm-note">No comments on them yet.</p></div></Panel> : null}
      {withComments.map((m) => (
        <Panel key={m.id}><div className="crm-card soc-thread">
          <a className="soc-thread-media" href={m.permalink} target="_blank" rel="noreferrer">
            {m.thumb ? <img src={m.thumb} alt="" /> : null}
            <span className="crm-sub">{new Date(m.timestamp).toLocaleDateString()} <ArrowUpRight size={12} /></span>
          </a>
          <div className="crm-stack">
            <p className="soc-post-title">{m.caption.split("\n")[0].slice(0, 120) || "No caption"}</p>
            {m.comments.map((c) => (
              <div key={c.id} className={`soc-comment${c.hidden ? " soc-hidden" : ""}`}>
                <p><b>{c.username}</b> {c.text}</p>
                <span className="crm-sub">{new Date(c.timestamp).toLocaleString()}{c.like_count ? ` · ${c.like_count} likes` : ""}{c.hidden ? " · Hidden" : ""}</span>
                {c.replies.map((r) => <p key={r.id} className="soc-reply"><b>{r.username}</b> {r.text}</p>)}
                <div className="crm-row">
                  <input className="soc-cell soc-reply-input" aria-label={`Reply to ${c.username}`} placeholder="Reply" value={draft[c.id] || ""}
                    onChange={(e) => setDraft({ ...draft, [c.id]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && draft[c.id]?.trim()) act(c, "reply", draft[c.id]); }} />
                  <Btn size="sm" loading={busy === c.id + "reply"} disabled={!draft[c.id]?.trim()} onClick={() => act(c, "reply", draft[c.id])}>Reply</Btn>
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act(c, c.hidden ? "unhide" : "hide")}>{c.hidden ? <Eye /> : <EyeSlash />}{c.hidden ? "Show" : "Hide"}</Button>
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => { if (confirm(`Delete ${c.username}'s comment from Instagram?`)) act(c, "delete"); }}><Trash />Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </div></Panel>
      ))}
    </div>
  );
}
