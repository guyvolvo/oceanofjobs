// /apply/history: every job the extension worked on, with how it ended.
import { useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Select } from "@cloudflare/kumo/components/select";
import { Empty } from "@cloudflare/kumo/components/empty";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { Status } from "../api";
import { JobCell, STATUS, StatusBadge, fmtDate, plural } from "../shared";
import { useApplyData } from "./data";
import { ApplyPage, Waiting } from "./Page";

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
      actions={rows.length ? <Select aria-label="Show" value={filter} onValueChange={(v) => setFilter((v as string) || "all")} items={items} /> : undefined}>
      {!data.history ? <Waiting /> : !rows.length ? (
        <LayerCard>
          <Empty icon={<ClockCounterClockwise size={40} />} title="No applications yet"
            description="Every job the extension works on shows up here, whether it was submitted or not." />
        </LayerCard>
      ) : (
        <>
          <LayerCard className="overflow-x-auto p-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Job</Table.Head>
                  <Table.Head className="hidden sm:table-cell">Status</Table.Head>
                  <Table.Head className="hidden sm:table-cell">Date</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {shown.map((r) => (
                  <Table.Row key={(r.attempt_id || r.job_id) + r.at}>
                    <Table.Cell className="align-top">
                      <JobCell title={r.title} link={r.link} sub={[r.company, r.reason].filter(Boolean).join(" · ")} />
                      {/* On a phone the status and date sit under the job instead of in columns of their own. */}
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden"><StatusBadge status={r.status} /><span className="whitespace-nowrap text-sm tabular-nums text-kumo-subtle">{fmtDate(r.at)}</span></span>
                    </Table.Cell>
                    <Table.Cell className="hidden align-top sm:table-cell"><StatusBadge status={r.status} /></Table.Cell>
                    <Table.Cell className="hidden align-top whitespace-nowrap tabular-nums sm:table-cell">{fmtDate(r.at)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
          {rows.length >= 100 ? <p className="m-0 text-kumo-subtle">Showing your 100 most recent applications.</p> : null}
        </>
      )}
    </ApplyPage>
  );
}
