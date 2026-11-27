// The Social page: write and schedule posts to Instagram, LinkedIn and
// TikTok, see them on a planner, read the numbers and answer comments.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Failed, useLoad } from "../App";
import { Loading, Panel } from "../ui";
import { Accounts } from "./Accounts";
import { Composer } from "./Composer";
import { Comments, Stats } from "./Insights";
import { Planner, PostList } from "./Posts";
import { NET, type Account, type Network, type Post } from "./data";

const VIEWS = { compose: "New post", planner: "Planner", posts: "Posts", stats: "Numbers", comments: "Comments", accounts: "Accounts" } as const;
type View = keyof typeof VIEWS;

export function Social() {
  const acc = useLoad<{ accounts: Account[]; key: boolean; callback: string }>("/social/accounts");
  const posts = useLoad<{ posts: Post[] }>("/social/posts");
  const [view, setView] = useState<View>("compose");
  const [editing, setEditing] = useState<{ post: Post | null; n: number }>({ post: null, n: 0 });
  const [focus, setFocus] = useState("");

  // Back from a network's sign-in page: say how it went and drop the query.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ok = q.get("social") as Network | null, err = q.get("social_error");
    if (!ok && !err) return;
    if (ok && NET[ok]) toast.success(`${NET[ok].name} connected`);
    if (err) toast.error(err);
    setView("accounts");
    history.replaceState(null, "", "/#social");
  }, []);

  if (acc.error) return <Failed error={acc.error} retry={acc.load} />;
  if (!acc.data) return <Loading />;
  const accounts = acc.data.accounts;
  const connected = accounts.filter((a) => a.connected);
  const list = posts.data?.posts || [];
  const counts = { scheduled: list.filter((p) => p.status === "scheduled").length, failed: list.filter((p) => p.status === "failed" || p.status === "partial").length };

  const edit = (p: Post | null, copy = false) => {
    setEditing((e) => ({ post: p ? (copy ? { ...p, sk: "", at: "", status: "draft", results: {} } as Post : p) : null, n: e.n + 1 }));
    setView("compose");
  };
  const done = () => { posts.load(); setEditing((e) => ({ post: null, n: e.n + 1 })); setView("posts"); };

  return (
    <div className="crm-stack">
      <div className="crm-row between">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList aria-label="Social">
            {(Object.keys(VIEWS) as View[]).map((v) => (
              <TabsTrigger key={v} value={v} className="px-3">
                {VIEWS[v]}{v === "planner" && counts.scheduled ? ` (${counts.scheduled})` : v === "posts" && counts.failed ? ` (${counts.failed} failed)` : ""}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="crm-note">{connected.length ? `Connected: ${connected.map((a) => NET[a.network].name).join(", ")}` : "No accounts connected yet"}</span>
      </div>

      {view === "compose" ? (
        !connected.length ? (
          <Panel><div className="crm-card crm-stack"><h2>Connect an account first</h2>
            <p className="crm-note">Posts go to the accounts you connect on the Accounts tab. You can still make images and save drafts.</p></div></Panel>
        ) : null
      ) : null}
      {view === "compose" ? (
        <Composer key={editing.n} accounts={accounts} initial={editing.post} onDone={done} />
      ) : null}
      {view === "planner" ? (posts.data ? <Planner posts={list} open={(p) => { setFocus(p.sk); setView("posts"); }} /> : <Loading />) : null}
      {view === "posts" ? (posts.error ? <Failed error={posts.error} retry={posts.load} /> : posts.data ? <PostList posts={list} reload={posts.load} edit={edit} focus={focus} /> : <Loading />) : null}
      {view === "stats" ? <Stats /> : null}
      {view === "comments" ? (accounts.find((a) => a.network === "instagram")?.connected ? <Comments />
        : <Panel><div className="crm-card"><p className="crm-note">Connect Instagram on the Accounts tab to read and answer comments here.</p></div></Panel>) : null}
      {view === "accounts" ? <Accounts accounts={accounts} keySet={acc.data.key} callback={acc.data.callback} reload={acc.load} /> : null}
    </div>
  );
}
