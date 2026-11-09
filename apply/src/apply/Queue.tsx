// /apply/queue: the jobs waiting for the extension, in the order it
// takes them.
import { useEffect, useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowDown, ArrowUp, Trash, Tray } from "@phosphor-icons/react";
import { apply, send, type QueueItem } from "../api";
import { useExtension } from "../ext";
import { ATS, ExtensionAction, JobCell, fmtDate, plural } from "../shared";
import { useApplyData } from "./data";
import { ApplyPage, Waiting } from "./Page";

const setOrder = (ids: string[]) => apply("queue-order", send("POST", { job_ids: ids }));

export default function QueuePage() {
  const data = useApplyData();
  const ext = useExtension();
  const toasts = useKumoToastManager();
  const items = data.queue;
  const [rows, setRows] = useState<QueueItem[]>(items || []);
  useEffect(() => { if (items) setRows(items); }, [items]);

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
        await apply(`queue/${encodeURIComponent(item.job_id)}`, send("PUT"));
        await setOrder(before.map((r) => r.job_id));
      } catch (e) {
        toasts.add({ variant: "error", title: "Couldn't put the job back", description: (e as Error).message });
      }
      data.reload();
    };
    toasts.add({ title: "Removed from your queue", description: item.title, actions: [{ children: "Undo", onClick: undo }] });
    data.reload();
  };

  return (
    <ApplyPage current="queue" title="Queue" data={data}
      note={items ? (rows.length ? `${plural(rows.length, "job")}, applied in this order.` : "Jobs waiting for auto apply.") : undefined}
      actions={items ? <ExtensionAction ext={ext} queue={rows} onOpened={data.reload} /> : undefined}>
      {!items ? <Waiting /> : rows.length ? (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Job</Table.Head>
                <Table.Head className="hidden sm:table-cell">Site</Table.Head>
                <Table.Head className="hidden sm:table-cell">Added</Table.Head>
                <Table.Head><span className="sr-only">Actions</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r, i) => (
                <Table.Row key={r.job_id}>
                  <Table.Cell className="align-top"><JobCell title={r.title} link={r.link} sub={r.company} /></Table.Cell>
                  <Table.Cell className="hidden align-top sm:table-cell">{ATS[r.ats] || r.ats || ""}</Table.Cell>
                  <Table.Cell className="hidden align-top whitespace-nowrap tabular-nums sm:table-cell">{fmtDate(r.added_at)}</Table.Cell>
                  <Table.Cell className="align-top">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" shape="square" variant="ghost" icon={<ArrowUp />} aria-label={`Move ${r.title} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                      <Button size="sm" shape="square" variant="ghost" icon={<ArrowDown />} aria-label={`Move ${r.title} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
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
    </ApplyPage>
  );
}
