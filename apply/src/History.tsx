import { useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Select } from "@cloudflare/kumo/components/select";
import { Empty } from "@cloudflare/kumo/components/empty";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { HistoryRow, Source, Status } from "./api";
import { JobCell, OutcomeSelect, SENT, SOURCE, STATUS, SourceLabel, StatusBadge, fmtDate, plural } from "./shared";

export function History({ rows, source, reload }: { rows: HistoryRow[]; source?: string; reload: () => void }) {
  const [filter, setFilter] = useState("all");
  const [from, setFrom] = useState(source && source in SOURCE ? source : "all");
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.status, (counts.get(r.status) || 0) + 1));
  const items: Record<string, string> = { all: `All (${rows.length})` };
  (Object.keys(STATUS) as Status[]).forEach((s) => { if (counts.get(s)) items[s] = `${STATUS[s].label} (${counts.get(s)})`; });
  const fromItems: Record<string, string> = { all: "From anywhere" };
  (Object.keys(SOURCE) as Source[]).forEach((s) => { if (rows.some((r) => r.source === s)) fromItems[s] = SOURCE[s].name; });
  const shown = rows.filter((r) => (filter === "all" || r.status === filter) && (from === "all" || r.source === from));

  if (!rows.length) {
    return (
      <LayerCard>
        <Empty icon={<ClockCounterClockwise size={40} />} title="No applications yet"
          description="Every job the extension works on shows up here, whether it was submitted or not." />
      </LayerCard>
    );
  }
  return (
    <div className="oj-stack">
      <div className="oj-row oj-row-between">
        <span className="oj-note">{plural(shown.length, "application")}</span>
        <div className="oj-row">
          {Object.keys(fromItems).length > 1 ? <Select aria-label="Where from" value={from} onValueChange={(v) => setFrom((v as string) || "all")} items={fromItems} /> : null}
          <Select aria-label="Show" value={filter} onValueChange={(v) => setFilter((v as string) || "all")} items={items} />
        </div>
      </div>
      <p className="oj-note">What happened is for you to mark. It doesn't change the status or your credits.</p>
      <LayerCard className="oj-table">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Job</Table.Head>
              <Table.Head className="oj-hide-sm">Status</Table.Head>
              <Table.Head className="oj-hide-sm">What happened?</Table.Head>
              <Table.Head className="oj-hide-sm">Date</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((r) => {
              const outcome = SENT.includes(r.status) ? <OutcomeSelect row={r} onChange={reload} /> : null;
              return (
                <Table.Row key={(r.attempt_id || r.job_id) + r.at}>
                  <Table.Cell>
                    <JobCell title={r.title} link={r.link} sub={[r.company, r.status === "sent" ? "" : r.reason].filter(Boolean).join(" · ")} />
                    <SourceLabel row={r} />
                    {/* On a phone the status, outcome and date sit under the job instead of in columns of their own. */}
                    <span className="oj-show-sm oj-row"><StatusBadge status={r.status} />{outcome}<span className="oj-note oj-num">{fmtDate(r.at)}</span></span>
                  </Table.Cell>
                  <Table.Cell className="oj-hide-sm"><StatusBadge status={r.status} /></Table.Cell>
                  <Table.Cell className="oj-hide-sm">{outcome}</Table.Cell>
                  <Table.Cell className="oj-hide-sm oj-num">{fmtDate(r.at)}</Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </LayerCard>
      {rows.length >= 100 ? <p className="oj-note">Showing your 100 most recent applications.</p> : null}
    </div>
  );
}
