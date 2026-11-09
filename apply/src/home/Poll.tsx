// The footer's live line, an island: when the scraper last swept, from the
// same status the board's light reads. Nothing if the call fails.
import { useEffect, useState } from "react";

export function Poll() {
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    fetch("/api/pipeline-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { const t = d?.scrape?.at ? new Date(d.scrape.at) : null; if (t && !isNaN(t.getTime())) setAt(t); })
      .catch(() => {});
  }, []);
  if (!at) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return <span className="home-poll"><span className="home-poll-dot" aria-hidden="true" />Last poll {pad(at.getUTCHours())}:{pad(at.getUTCMinutes())} UTC</span>;
}
