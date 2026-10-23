import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Button } from "@cloudflare/kumo/components/button";
import { WarningCircle } from "@phosphor-icons/react";
import { apply, ApiError, type HistoryRow, type Need, type QueueItem, type Summary } from "./api";
import { useExtension } from "./ext";
import { Overview, PLAN } from "./Overview";
// Everything past the overview loads when its tab is opened.
const Queue = lazy(() => import("./Queue").then((m) => ({ default: m.Queue })));
const Attention = lazy(() => import("./Attention").then((m) => ({ default: m.Attention })));
const History = lazy(() => import("./History").then((m) => ({ default: m.History })));
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Agent = lazy(() => import("./Agent").then((m) => ({ default: m.Agent })));
import { plural } from "./shared";

const SECTIONS = ["overview", "queue", "needs", "history", "settings", "agent"] as const;
type Section = (typeof SECTIONS)[number];
const fromHash = (): Section => {
  const h = location.hash.slice(1);
  return (SECTIONS as readonly string[]).includes(h) ? (h as Section) : "overview";
};

type Data = { summary?: Summary; queue?: QueueItem[]; needs?: Need[]; history?: HistoryRow[] };

export function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const [section, setSection] = useState<Section>(fromHash);
  const [data, setData] = useState<Data>({});
  const [failed, setFailed] = useState(false);
  const ext = useExtension();

  useEffect(() => {
    const on = () => setSection(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (s: string) => {
    // replaceState, so switching sections doesn't fill Back with tabs.
    history.replaceState(null, "", s === "overview" ? location.pathname : `#${s}`);
    setSection(s as Section);
    scrollTo(0, 0);
  };

  const load = useCallback(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const got = await Promise.allSettled([
      apply<Summary>(`summary?tz=${encodeURIComponent(tz)}`),
      apply<{ queue: QueueItem[] }>("queue"),
      apply<{ needs: Need[] }>("needs"),
      apply<{ applied: HistoryRow[] }>("history?limit=100"),
    ]);
    if (got.some((g) => g.status === "rejected" && g.reason instanceof ApiError && g.reason.status === 401)) return onSignedOut();
    const v = <T,>(g: PromiseSettledResult<T>) => (g.status === "fulfilled" ? g.value : undefined);
    const [s, q, n, h] = got;
    setData((d) => ({
      summary: v(s as PromiseSettledResult<Summary>) ?? d.summary,
      queue: v(q as PromiseSettledResult<{ queue: QueueItem[] }>)?.queue ?? d.queue,
      needs: v(n as PromiseSettledResult<{ needs: Need[] }>)?.needs ?? d.needs,
      history: v(h as PromiseSettledResult<{ applied: HistoryRow[] }>)?.applied ?? d.history,
    }));
    setFailed(got.some((g) => g.status === "rejected"));
  }, [onSignedOut]);

  useEffect(() => {
    load();
    // Back from the tab the extension opened: the queue and history moved.
    const on = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [load]);

  const s = data.summary;
  const attention = s ? s.needs_input + s.unconfirmed : 0;
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "queue", label: s?.queued ? `Queue (${s.queued})` : "Queue" },
    { value: "needs", label: attention ? `Needs attention (${attention})` : "Needs attention" },
    { value: "history", label: "History" },
    { value: "settings", label: "Settings" },
    { value: "agent", label: "AI agent" },
  ];
  const waiting = <div className="oj-row oj-note"><Loader /> Loading</div>;

  return (
    <>
      <p className="oj-note">{s ? `${PLAN[s.plan] || "Free plan"} · ${plural(s.remaining, "application")} left ${s.period === "day" ? "today" : "this month"}` : " "}</p>
      {failed ? (
        <Banner variant="error" icon={<WarningCircle weight="fill" />} title="Couldn't load everything"
          description="Some of what's shown here may be out of date." action={<Button onClick={load}>Try again</Button>} />
      ) : null}
      {s && s.remaining === 0 ? (
        <Banner variant="alert" icon={<WarningCircle weight="fill" />} title={`No applications left ${s.period === "day" ? "today" : "this month"}`}
          description="Jobs stay in your queue until your plan's limit resets." />
      ) : null}
      <div className="oj-tabs">
        <Tabs variant="segmented" tabs={tabs} value={section} onValueChange={go} />
      </div>
      <Suspense fallback={waiting}><div role="tabpanel">
        {section === "overview" && (s ? <Overview s={s} ext={ext} queue={data.queue} reload={load} /> : waiting)}
        {section === "queue" && (data.queue ? <Queue items={data.queue} ext={ext} reload={load} /> : waiting)}
        {section === "needs" && (data.needs && data.history ? <Attention needs={data.needs} history={data.history} disputesLeft={s?.disputes_left ?? 0} reload={load} /> : waiting)}
        {section === "history" && (data.history ? <History rows={data.history} /> : waiting)}
        {section === "settings" && <Settings />}
        {section === "agent" && <Agent />}
      </div></Suspense>
    </>
  );
}
