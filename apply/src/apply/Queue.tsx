// /apply/queue: the jobs waiting for the extension, in the order it
// takes them.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowDown, ArrowUp, Trash, Tray } from "@/components/icons";
import { apply, send, type QueueItem } from "../api";
import { useExtension } from "../ext";
import { ATS, ExtensionAction, JobCell, SOURCE, SourceLabel, fmtDate, plural } from "../shared";
import { useApplyData } from "./data";
import { ApplyPage, Nothing, PANEL, Waiting } from "./Page";

const setOrder = (ids: string[]) => apply("queue-order", send("POST", { job_ids: ids }));

export default function QueuePage() {
  const data = useApplyData();
  const ext = useExtension();
  const items = data.queue;
  const [rows, setRows] = useState<QueueItem[]>(items || []);
  useEffect(() => { if (items) setRows(items); }, [items]);
  // From the Overview's breakdown (?source=mcp): one source only, so no reordering.
  const source = new URLSearchParams(location.search).get("source");
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
      toast.error("Couldn't change the order", { description: "Try again." });
    }
  };

  const remove = async (item: QueueItem) => {
    const before = rows;
    setRows(rows.filter((r) => r.job_id !== item.job_id));
    try {
      await apply(`queue/${encodeURIComponent(item.job_id)}`, send("DELETE"));
    } catch {
      setRows(before);
      return void toast.error("Couldn't remove the job", { description: "Try again." });
    }
    // Undo puts it back where it was, not at the end.
    const undo = async () => {
      try {
        await apply(`queue/${encodeURIComponent(item.job_id)}`, send("PUT", { source: item.source === "alert" ? "alert" : "board", requeue: true }));
        await setOrder(before.map((r) => r.job_id));
      } catch (e) {
        toast.error("Couldn't put the job back", { description: (e as Error).message });
      }
      data.reload();
    };
    toast("Removed from your queue", { description: item.title, action: { label: "Undo", onClick: () => { undo(); } } });
    data.reload();
  };

  return (
    <ApplyPage current="queue" title="Queue" data={data}
      note={items ? (only ? <>{plural(shown.length, "job")} from {SOURCE[only].from}. <a className="underline underline-offset-3" href="/apply/queue">Show the whole queue</a></> : rows.length ? `${plural(rows.length, "job")}, applied in this order.` : "Jobs waiting for auto apply.") : undefined}
      actions={items ? <ExtensionAction ext={ext} queue={rows} onOpened={data.reload} /> : undefined}>
      {!items ? <Waiting /> : rows.length ? (
        <div className={PANEL}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Job</TableHead>
                <TableHead className="hidden sm:table-cell">Site</TableHead>
                <TableHead className="hidden sm:table-cell">Added</TableHead>
                <TableHead className="pr-4"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r, i) => (
                <TableRow key={r.job_id}>
                  <TableCell className="whitespace-normal pl-4 align-top"><JobCell title={r.title} link={r.link} sub={r.company} /><SourceLabel row={r} /></TableCell>
                  <TableCell className="hidden align-top sm:table-cell">{ATS[r.ats] || r.ats || ""}</TableCell>
                  <TableCell className="hidden align-top tabular-nums sm:table-cell">{fmtDate(r.added_at)}</TableCell>
                  <TableCell className="pr-4 align-top">
                    <div className="flex justify-end gap-1">
                      {only ? null : <>
                        <Button size="icon-sm" variant="ghost" aria-label={`Move ${r.title} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Move ${r.title} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                      </>}
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${r.title}`} onClick={() => remove(r)}><Trash /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Nothing icon={<Tray />} title="Your queue is empty"
          description="Add jobs with the Auto apply button on the job board, or ask your AI assistant to queue them for you.">
          <Button variant="outline" asChild><a href="/board">Open the job board</a></Button>
        </Nothing>
      )}
    </ApplyPage>
  );
}
