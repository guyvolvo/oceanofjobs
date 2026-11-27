// Every post: a month planner, and the list with each network's outcome,
// its link, Instagram's numbers, and retry, edit, duplicate and delete.
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowUpRight, CaretLeft, CaretRight, Copy, PencilSimple, Repeat, Trash } from "@/components/icons";
import { crm } from "../api";
import { Loading, Panel } from "../ui";
import { NET, RESULT, STATUS, postKey, postTime, when, type Post, type Status } from "./data";

const tone = (s: Status | string) => (s === "done" || s === "posted" || s === "inbox" ? "soc-ok" : s === "failed" ? "soc-bad" : s === "partial" ? "soc-warn" : "");
const excerpt = (p: Post) => p.title || p.caption.split("\n")[0].slice(0, 90) || Object.values(p.captions || {})[0]?.slice(0, 90) || "No text";
const thumb = (p: Post) => p.media[0];

export function Planner({ posts, open }: { posts: Post[]; open: (p: Post) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const days = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - ((start.getDay() + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const byDay = useMemo(() => {
    const m: Record<string, Post[]> = {};
    for (const p of posts) {
      if (p.status === "draft") continue;
      const d = new Date(postTime(p));
      (m[d.toDateString()] ||= []).push(p);
    }
    return m;
  }, [posts]);
  const today = new Date().toDateString();
  return (
    <Panel><div className="crm-card crm-stack">
      <div className="crm-row between">
        <h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <div className="crm-row">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><CaretLeft /></Button>
          <Button variant="outline" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</Button>
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><CaretRight /></Button>
        </div>
      </div>
      <div className="soc-cal" role="grid" aria-label="Posts by day">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="soc-cal-head" role="columnheader">{d}</div>)}
        {days.map((d) => {
          const list = (byDay[d.toDateString()] || []).sort((a, b) => postTime(a).localeCompare(postTime(b)));
          return (
            <div key={d.toISOString()} role="gridcell" className={`soc-cal-day${d.getMonth() !== month.getMonth() ? " soc-cal-out" : ""}${d.toDateString() === today ? " soc-cal-today" : ""}`}>
              <span className="soc-cal-n">{d.getDate()}</span>
              {list.map((p) => (
                <button key={p.sk} type="button" className={`soc-cal-post ${tone(p.status)}`} onClick={() => open(p)}>
                  <span>{new Date(postTime(p)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="soc-cal-icons">{p.networks.map((n) => { const I = NET[n].icon; return <I key={n} size={12} />; })}</span>
                  <span className="soc-cal-text">{excerpt(p)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div></Panel>
  );
}

type Stats = { instagram?: { likes: number | null; comments: number | null; reach?: number; saved?: number; shares?: number; views?: number; error?: string } };
const FILTERS = { all: "All", scheduled: "Scheduled", draft: "Drafts", sent: "Sent", failed: "Failed" } as const;

export function PostList({ posts, reload, edit, focus }: { posts: Post[]; reload: () => void; edit: (p: Post, copy?: boolean) => void; focus?: string }) {
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [stats, setStats] = useState<Record<string, Stats | "loading">>({});
  const [busy, setBusy] = useState("");
  const shown = posts.filter((p) => filter === "all" || (filter === "sent" ? ["done", "partial", "publishing"].includes(p.status)
    : filter === "failed" ? p.status === "failed" || p.status === "partial" : p.status === filter))
    .sort((a, b) => postTime(b).localeCompare(postTime(a)));
  const act = async (p: Post, what: string, fn: () => Promise<unknown>) => {
    setBusy(p.sk + what);
    try { await fn(); reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  };
  const loadStats = (p: Post) => {
    setStats((s) => ({ ...s, [p.sk]: "loading" }));
    crm<{ stats: Stats }>(`/social/posts/${postKey(p.sk)}/stats`).then((r) => setStats((s) => ({ ...s, [p.sk]: r.stats })),
      (e) => { toast.error(e.message); setStats((s) => { const { [p.sk]: _, ...rest } = s; return rest; }); });
  };
  return (
    <Panel><div className="crm-card crm-stack">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as keyof typeof FILTERS)}>
        <TabsList aria-label="Show">{Object.entries(FILTERS).map(([k, l]) => <TabsTrigger key={k} value={k} className="px-3">{l}</TabsTrigger>)}</TabsList>
      </Tabs>
      {!shown.length ? <p className="crm-note">No posts here yet.</p> : (
        <Table className="soc-posts"><TableBody>
          {shown.map((p) => {
            const m = thumb(p), st = stats[p.sk];
            const failed = p.networks.some((n) => p.results[n]?.state === "failed");
            const ig = st && st !== "loading" ? st.instagram : undefined;
            return (
              <Fragment key={p.sk}>
                <TableRow className={focus === p.sk ? "soc-focus" : undefined}>
                  <TableCell className="soc-post-thumb">{m ? (m.type === "video" ? <video src={m.url} muted preload="metadata" /> : <img src={m.url} alt="" />) : <span />}</TableCell>
                  <TableCell>
                    <b className="soc-post-title">{excerpt(p)}</b>
                    <span className="crm-sub">
                      {p.status === "scheduled" ? `Goes out ${when(p.at)}` : p.status === "draft" ? `Edited ${when(p.updated)}` : when(postTime(p))}
                      {p.media.length > 1 ? ` · ${p.media.length} items` : ""}
                    </span>
                    <div className="soc-results">
                      {p.networks.map((n) => {
                        const r = p.results[n], I = NET[n].icon;
                        return (
                          <span key={n} className={`soc-result ${tone(r?.state || "")}`} title={r?.error || undefined}>
                            <I size={14} />{r ? RESULT[r.state] : p.status === "scheduled" ? "Scheduled" : "Draft"}
                            {r?.url ? <a href={r.url} target="_blank" rel="noreferrer" aria-label={`Open on ${NET[n].name}`}><ArrowUpRight size={14} /></a> : null}
                          </span>
                        );
                      })}
                    </div>
                    {p.networks.map((n) => { const e = p.results[n]?.error; return e ? <p key={n} className="soc-error">{e.startsWith(NET[n].name) ? e : `${NET[n].name}: ${e}`}</p> : null; })}
                    {ig ? (
                      <div className="soc-stats-line">
                        {([["likes", "likes"], ["comments", "comments"], ["reach", "reached"], ["views", "views"], ["saved", "saves"], ["shares", "shares"]] as const)
                          .filter(([k]) => ig[k] !== undefined && ig[k] !== null).map(([k, l]) => <span key={k}><b>{Number(ig[k]).toLocaleString()}</b> {l}</span>)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell><Badge variant="outline" className={`soc-badge ${tone(p.status)}`}>{STATUS[p.status]}</Badge></TableCell>
                  <TableCell className="soc-post-tools">
                    {p.results.instagram?.state === "posted" ? (
                      <Button variant="ghost" size="sm" disabled={st === "loading"} onClick={() => loadStats(p)}>{st === "loading" ? "Loading" : ig ? "Refresh numbers" : "Numbers"}</Button>
                    ) : null}
                    {failed ? <Button variant="ghost" size="sm" disabled={busy === p.sk + "retry"} onClick={() => act(p, "retry", () => crm(`/social/posts/${postKey(p.sk)}/retry`, "POST"))}><Repeat />Try again</Button> : null}
                    {["draft", "scheduled"].includes(p.status) ? <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => edit(p)}><PencilSimple /></Button> : null}
                    <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={() => edit(p, true)}><Copy /></Button>
                    <Button variant="ghost" size="icon" aria-label="Delete" disabled={busy === p.sk + "del"} onClick={() => {
                      const live = p.networks.some((n) => ["posted", "inbox"].includes(p.results[n]?.state || ""));
                      if (confirm(live ? "Delete this post from the CRM? It stays up on the networks." : "Delete this post?")) act(p, "del", () => crm(`/social/posts/${postKey(p.sk)}`, "DELETE"));
                    }}><Trash /></Button>
                  </TableCell>
                </TableRow>
              </Fragment>
            );
          })}
        </TableBody></Table>
      )}
    </div></Panel>
  );
}

export const PostsLoading = () => <Loading>Loading posts</Loading>;
