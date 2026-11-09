// /apply/history: every job the extension worked on, with how it ended.
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "../fields";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { Status } from "../api";
import { JobCell, STATUS, StatusBadge, fmtDate, plural } from "../shared";
import { useApplyData } from "./data";
import { ApplyPage, Nothing, PANEL, Waiting } from "./Page";

export default function HistoryPage() {
  const data = useApplyData();
  const [filter, setFilter] = useState("all");
  const rows = data.history || [];
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.status, (counts.get(r.status) || 0) + 1));
  const items: Record<string, string> = { all: `All (${rows.length})` };
  (Object.keys(STATUS) as Status[]).forEach((s) => { if (counts.get(s)) items[s] = `${STATUS[s].label} (${counts.get(s)})`; });
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  return (
    <ApplyPage current="history" title="Applications" data={data}
      note={data.history ? (rows.length ? plural(shown.length, "application") : "Every job the extension works on shows up here, whether it was submitted or not.") : undefined}
      actions={rows.length ? <SelectField aria-label="Show" className="w-auto min-w-[200px]" value={filter} onValueChange={(v) => setFilter(v || "all")} items={items} /> : undefined}>
      {!data.history ? <Waiting /> : !rows.length ? (
        <Nothing icon={<ClockCounterClockwise />} title="No applications yet"
          description="Every job the extension works on shows up here, whether it was submitted or not." />
      ) : (
        <>
          <div className={PANEL}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Job</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden pr-4 sm:table-cell">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={(r.attempt_id || r.job_id) + r.at}>
                    <TableCell className="whitespace-normal pl-4 align-top">
                      <JobCell title={r.title} link={r.link} sub={[r.company, r.reason].filter(Boolean).join(" · ")} />
                      {/* On a phone the status and date sit under the job instead of in columns of their own. */}
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden"><StatusBadge status={r.status} /><span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">{fmtDate(r.at)}</span></span>
                    </TableCell>
                    <TableCell className="hidden align-top sm:table-cell"><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="hidden pr-4 align-top tabular-nums sm:table-cell">{fmtDate(r.at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {rows.length >= 100 ? <p className="m-0 text-muted-foreground">Showing your 100 most recent applications.</p> : null}
        </>
      )}
    </ApplyPage>
  );
}
