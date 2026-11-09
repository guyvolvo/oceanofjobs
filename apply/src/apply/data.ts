// What every auto apply page shares: the summary, the queue, the
// questions waiting and the history, loaded together (the old dashboard's
// load) and again when the tab comes back into view, since the extension
// opens jobs in tabs of its own. A 401 means signed out.
import { useCallback, useEffect, useState } from "react";
import { apply, ApiError, type HistoryRow, type Need, type QueueItem, type Summary } from "../api";
import { useAuth } from "../site/auth";
import { plural } from "../shared";

export type ApplyData = {
  summary?: Summary; queue?: QueueItem[]; needs?: Need[]; history?: HistoryRow[];
  failed: boolean; signedOut: boolean; reload: () => void;
};
type Loaded = Pick<ApplyData, "summary" | "queue" | "needs" | "history">;

export const PLAN_NAME = { free: "Free", basic: "Basic", pro: "Pro" };
export const period = (s: Summary) => (s.period === "day" ? "today" : "this month");
// Under the brand in the sidebar: "Pro · 48 applications left this month".
export const statusLine = (s?: Summary) => (s ? `${PLAN_NAME[s.plan] || "Free"} · ${plural(s.remaining, "application")} left ${period(s)}` : undefined);
export const badges = (s?: Summary) => (s ? { queue: s.queued, needs: s.needs_input + s.unconfirmed } : {});

export function useApplyData(): ApplyData {
  const who = useAuth();
  const [data, setData] = useState<Loaded>({});
  const [failed, setFailed] = useState(false);
  const [signedOut, setSignedOut] = useState(!who);

  const reload = useCallback(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const got = await Promise.allSettled([
      apply<Summary>(`summary?tz=${encodeURIComponent(tz)}`),
      apply<{ queue: QueueItem[] }>("queue"),
      apply<{ needs: Need[] }>("needs"),
      apply<{ applied: HistoryRow[] }>("history?limit=100"),
    ]);
    if (got.some((g) => g.status === "rejected" && g.reason instanceof ApiError && g.reason.status === 401)) return setSignedOut(true);
    const v = <T,>(g: PromiseSettledResult<T>) => (g.status === "fulfilled" ? g.value : undefined);
    const [s, q, n, h] = got;
    setData((d) => ({
      summary: v(s) ?? d.summary,
      queue: v(q)?.queue ?? d.queue,
      needs: v(n)?.needs ?? d.needs,
      history: v(h)?.applied ?? d.history,
    }));
    setFailed(got.some((g) => g.status === "rejected"));
  }, []);

  useEffect(() => {
    // Signed out: nothing of the last reader stays in memory or on screen.
    if (!who) { setSignedOut(true); setData({}); return; }
    setSignedOut(false);
    reload();
    const on = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [who, reload]);

  return { ...data, failed, signedOut, reload };
}
