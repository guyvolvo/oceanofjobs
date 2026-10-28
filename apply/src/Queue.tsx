import { useEffect, useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowDown, ArrowUp, Trash, Tray } from "@phosphor-icons/react";
import { apply, send, type QueueItem } from "./api";
import type { Ext } from "./ext";
import { ATS, ExtensionAction, JobCell, SOURCE, SourceLabel, fmtDate, plural } from "./shared";

const setOrder = (ids: string[]) => apply("queue-order", send("POST", { job_ids: ids }));

export function Queue({ items, ext, reload, source }: { items: QueueItem[]; ext: Ext; reload: () => void; source?: string }) {
  const toasts = useKumoToastManager();
  const [rows, setRows] = useState(items);
  useEffect(() => setRows(items), [items]);
  // From the Overview's breakdown: one source only, so no reordering.
  const only = source && source in SOURCE ? (source as keyof typeof SOURCE) : null;
  const shown = only ? rows.filter((r) => r.source === only) : rows;

  const move = async (i: number, d: -1 | 1) => {
    const next = rows.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setRows(next);
    try {
      await setOrder(next.map((r) => r.job_id));
    } catch {
      setRows(rows);
      toasts.add({ variant: "error", title: "Couldn't change the order", description: "Try again." });
    }
  };

  const remove = async (item: QueueItem) => {
    const before = rows;
    setRows(rows.filter((r) => r.job_id !== item.job_id));
    try {
      await apply(`queue/${encodeURIComponent(item.job_id)}`, send("DELETE"));
    } catch {
      setRows(before);
      return toasts.add({ variant: "error", title: "Couldn't remove the job", description: "Try again." });
    }
    // Undo puts it back where it was, not at the end.
    const undo = async () => {
      try {
        await apply(`queue/${encodeURIComponent(item.job_id)}`, send("PUT", { source: item.source === "alert" ? "alert" : "board", requeue: true }));
        await setOrder(before.map((r) => r.job_id));
      } catch (e) {
        toasts.add({ variant: "error", title: "Couldn't put the job back", description: (e as Error).message });
      }
      reload();
    };
    toasts.add({ title: "Removed from your queue", description: item.title, actions: [{ children: "Undo", onClick: undo }] });
    reload();
  };

  return (
    <div className="oj-stack">
      <div className="oj-row oj-row-between">
        <p className="oj-note">
          {only ? <>{plural(shown.length, "job")} from {SOURCE[only].from}. <a className="oj-link" href="#queue">Show the whole queue</a></>
            : rows.length ? `${plural(rows.length, "job")}, applied in this order.` : ""}
        </p>
        <ExtensionAction ext={ext} queue={rows} onOpened={reload} />
      </div>
      {rows.length ? (
        <LayerCard className="oj-table">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Job</Table.Head>
                <Table.Head className="oj-hide-sm">Site</Table.Head>
                <Table.Head className="oj-hide-sm">Added</Table.Head>
                <Table.Head><span className="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.map((r, i) => (
                <Table.Row key={r.job_id}>
                  <Table.Cell><JobCell title={r.title} link={r.link} sub={r.company} /><SourceLabel row={r} /></Table.Cell>
                  <Table.Cell className="oj-hide-sm">{ATS[r.ats] || r.ats || ""}</Table.Cell>
                  <Table.Cell className="oj-hide-sm oj-num">{fmtDate(r.added_at)}</Table.Cell>
                  <Table.Cell>
                    <div className="oj-actions">
                      {only ? null : <>
                        <Button size="sm" shape="square" variant="ghost" icon={<ArrowUp />} aria-label={`Move ${r.title} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                        <Button size="sm" shape="square" variant="ghost" icon={<ArrowDown />} aria-label={`Move ${r.title} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
                      </>}
                      <Button size="sm" shape="square" variant="ghost" icon={<Trash />} aria-label={`Remove ${r.title}`} onClick={() => remove(r)} />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      ) : (
        <LayerCard>
          <Empty
            icon={<Tray size={40} />}
            title="Your queue is empty"
            description="Add jobs with the Auto apply button on the job board, or ask your AI assistant to queue them for you."
            contents={<LinkButton href="/board" variant="secondary">Open the job board</LinkButton>}
          />
        </LayerCard>
      )}
    </div>
  );
}
