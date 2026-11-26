// /apply/needs: forms that asked something the settings don't cover, and
// submissions the extension couldn't confirm.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AreaField, LoadingButton } from "../fields";
import { CheckCircle, Info } from "@/components/icons";
import { apply, send, ApiError, type HistoryRow, type Need } from "../api";
import { JobCell, fmtDate, plural } from "../shared";
import { useApplyData } from "./data";
import { ApplyPage, Banner, Card, Nothing, PANEL, Waiting } from "./Page";

function Questions({ need, reload }: { need: Need; reload: () => void }) {
  // The AI's draft, when it wrote one, ready to approve as is or edit.
  const [answers, setAnswers] = useState<string[]>(() => need.questions.map((q) => need.drafts?.[q] ?? ""));
  const [busy, setBusy] = useState(false);
  const ready = answers.every((a) => a.trim());

  // Each answer joins the saved answers, then the job goes back in the
  // queue so the extension can try it again.
  const save = async () => {
    setBusy(true);
    try {
      for (const [i, question] of need.questions.entries()) {
        await apply("answers", send("POST", { question, answer: answers[i].trim(), job_id: need.job_id }));
      }
      await apply(`queue/${encodeURIComponent(need.job_id)}`, send("PUT", { requeue: true }));
      toast.success("Answers saved", { description: `${need.title} is back in your queue.` });
      reload();
    } catch (e) {
      toast.error("Couldn't save your answers", { description: e instanceof ApiError && e.status !== 0 && e.status < 500 ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div><JobCell title={need.title} link={need.link} sub={need.company} /></div>
      {need.questions.map((q, i) => (
        <AreaField key={q} label={q} rows={2} value={answers[i]}
          description={need.drafts?.[q] ? "The AI drafted this answer. Check it, change anything that isn't right, then save." : undefined}
          onValueChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))} />
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LoadingButton loading={busy} disabled={!ready} onClick={save}>Save and queue again</LoadingButton>
        {!ready ? <span className="text-muted-foreground">Answer every question to continue.</span> : null}
      </div>
    </Card>
  );
}

// Every question answered, but the site checks that a person sends the
// form, so the extension stopped short of Submit. Filling it in again from
// the extension takes it off this list.
function Ready({ need }: { need: Need }) {
  return (
    <Card note="Ready to submit. This site checks that a person sends the form, so the extension stopped before Submit. Open the application, click Fill application in the extension, check the answers, then press the site's Submit button.">
      <div className="-order-1"><JobCell title={need.title} link={need.link} sub={need.company} /></div>
      <div><Button asChild><a href={need.link} target="_blank" rel="noopener">Open the application</a></Button></div>
    </Card>
  );
}

function DisputeButton({ row, left, reload }: { row: HistoryRow; left: number; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dispute = async () => {
    setBusy(true);
    try {
      await apply(`attempts/${encodeURIComponent(row.attempt_id!)}/dispute`, send("POST"));
      setOpen(false);
      toast.success("Credit refunded", { description: `You can queue ${row.title} again.` });
      reload();
    } catch (e) {
      toast.error("Couldn't refund the credit", { description: e instanceof ApiError && e.code === "not_disputable" ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm" disabled={!left}>Refund credit</Button></DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
        <DialogTitle className="leading-snug">Refund the credit for this application?</DialogTitle>
        <DialogDescription>
          Use this if {row.title} at {row.company || "this company"} never received your application.
          The credit goes back to your plan and you can queue the job again. {plural(left, "refund")} left this month.
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <LoadingButton loading={busy} onClick={dispute}>Refund credit</LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AttentionPage() {
  const data = useApplyData();
  const { needs, history } = data;
  // Only attempts (extension 1.9 on) count against the plan. Older unconfirmed
  // entries were never charged, so they stay in History and not here.
  const unconfirmed = (history || []).filter((r) => r.status === "unconfirmed" && r.attempt_id);
  const disputesLeft = data.summary?.disputes_left ?? 0;
  return (
    <ApplyPage current="needs" title="Needs attention" data={data}>
      {!needs || !history ? <Waiting /> : !needs.length && !unconfirmed.length ? (
        <Nothing icon={<CheckCircle />} title="Looks good" description="Nothing waits for you." />
      ) : (
        <>
          {needs.length ? (
            <section className="flex flex-col gap-3" aria-labelledby="needs-title">
              <h2 className="m-0 text-base font-semibold leading-snug text-foreground" id="needs-title">Questions to answer</h2>
              <p className="m-0 text-muted-foreground">These forms asked something your settings don't cover. Your answers are saved and reused on later applications.</p>
              {needs.map((n) => (n.ready ? <Ready key={n.attempt_id} need={n} /> : <Questions key={n.attempt_id} need={n} reload={data.reload} />))}
            </section>
          ) : null}
          {unconfirmed.length ? (
            <section className="flex flex-col gap-3" aria-label="Unconfirmed applications">
              <Banner tone="warning" icon={<Info weight="fill" className="text-[var(--ooj-trend-down)]" />} title="Unconfirmed applications"
                description="The auto apply extension filled out the application for these jobs but couldn't confirm whether it went through. If an application didn't go through, click Refund credit within 14 days of applying." />
              <div className={PANEL}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Job</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="pr-4"><span className="sr-only">Actions</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unconfirmed.map((r) => (
                      <TableRow key={r.attempt_id || r.job_id}>
                        <TableCell className="whitespace-normal pl-4 align-top"><JobCell title={r.title} link={r.link} sub={[r.company, r.reason].filter(Boolean).join(" · ")} /></TableCell>
                        <TableCell className="align-top tabular-nums">{fmtDate(r.at)}</TableCell>
                        <TableCell className="pr-4 align-top">
                          <div className="flex justify-end">
                            {r.disputable && r.attempt_id ? <DisputeButton row={r} left={disputesLeft} reload={data.reload} /> : <span className="text-muted-foreground">Can't be refunded</span>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ) : null}
        </>
      )}
    </ApplyPage>
  );
}
