import { useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Select } from "@cloudflare/kumo/components/select";
import { Empty } from "@cloudflare/kumo/components/empty";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { HistoryRow, Status } from "./api";
import { JobCell, STATUS, StatusBadge, fmtDate } from "./shared";

export function History({ rows }: { rows: HistoryRow[] }) {
  const [filter, setFilter] = useState("all");
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.status, (counts.get(r.status) || 0) + 1));
  const items: Record<string, string> = { all: `All (${rows.length})` };
  (Object.keys(STATUS) as Status[]).forEach((s) => { if (counts.get(s)) items[s] = `${STATUS[s].label} (${counts.get(s)})`; });
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

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
      <div className="oj-filter">
        <Select label="Show" value={filter} onValueChange={(v) => setFilter((v as string) || "all")} items={items} />
      </div>
      <LayerCard className="oj-table">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Job</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Date</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((r) => (
              <Table.Row key={(r.attempt_id || r.job_id) + r.at}>
                <Table.Cell><JobCell title={r.title} link={r.link} sub={[r.company, r.reason].filter(Boolean).join(" · ")} /></Table.Cell>
                <Table.Cell><StatusBadge status={r.status} /></Table.Cell>
                <Table.Cell className="oj-num">{fmtDate(r.at)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
      {rows.length >= 100 ? <p className="oj-note">Showing your 100 most recent applications.</p> : null}
    </div>
  );
}
