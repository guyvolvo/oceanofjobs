import { useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button } from "@cloudflare/kumo/components/button";
import { InputArea } from "@cloudflare/kumo/components/input";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Table } from "@cloudflare/kumo/components/table";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { CheckCircle, Info } from "@phosphor-icons/react";
import { apply, send, ApiError, type HistoryRow, type Need } from "./api";
import { JobCell, JobLink, fmtDate, plural } from "./shared";

function Questions({ need, reload }: { need: Need; reload: () => void }) {
  const toasts = useKumoToastManager();
  const [answers, setAnswers] = useState<string[]>(() => need.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const ready = answers.every((a) => a.trim());

  // Each answer joins the saved answers, then the job goes back in the
  // queue so the extension can try it again.
  const save = async () => {
    setBusy(true);
    try {
      for (const [i, question] of need.questions.entries()) {
        await apply("answers", send("POST", { question, answer: answers[i].trim() }));
      }
      await apply(`queue/${encodeURIComponent(need.job_id)}`, send("PUT"));
      toasts.add({ variant: "success", title: "Answers saved", description: `${need.title} is back in your queue.` });
      reload();
    } catch (e) {
      toasts.add({ variant: "error", title: "Couldn't save your answers", description: e instanceof ApiError && e.status !== 0 && e.status < 500 ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <LayerCard>
      <div className="oj-card-body">
        <div>
          <JobLink title={need.title} link={need.link} />
          <span className="oj-sub">{need.company}</span>
        </div>
        {need.questions.map((q, i) => (
          <InputArea key={q} label={q} autoResize minRows={2} value={answers[i]}
            onValueChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))} />
        ))}
        <div className="oj-row">
          <Button variant="primary" loading={busy} disabled={!ready} onClick={save}>Save and queue again</Button>
          {!ready ? <span className="oj-note">Answer every question to continue.</span> : null}
        </div>
      </div>
    </LayerCard>
  );
}

function DisputeButton({ row, left, reload }: { row: HistoryRow; left: number; reload: () => void }) {
  const toasts = useKumoToastManager();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dispute = async () => {
    setBusy(true);
    try {
      await apply(`attempts/${encodeURIComponent(row.attempt_id!)}/dispute`, send("POST"));
      setOpen(false);
      toasts.add({ variant: "success", title: "Credit refunded", description: `You can queue ${row.title} again.` });
      reload();
    } catch (e) {
      toasts.add({ variant: "error", title: "Couldn't dispute this application", description: e instanceof ApiError && e.code === "not_disputable" ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(p) => <Button {...p} size="sm" variant="secondary" disabled={!left}>Dispute</Button>} />
      <Dialog className="oj-dialog">
        <Dialog.Title className="oj-card-title">Mark this application as not sent?</Dialog.Title>
        <Dialog.Description className="oj-note">
          Use this if {row.title} at {row.company || "this company"} never received your application.
          The credit goes back to your plan and you can queue the job again. {plural(left, "dispute")} left.
        </Dialog.Description>
        <div className="oj-row oj-dialog-actions">
          <Dialog.Close render={(p) => <Button {...p} variant="secondary">Cancel</Button>} />
          <Button variant="primary" loading={busy} onClick={dispute}>Mark as not sent</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

export function Attention({ needs, history, disputesLeft, reload }: { needs: Need[]; history: HistoryRow[]; disputesLeft: number; reload: () => void }) {
  // Only attempts (extension 1.9 on) count against the plan. Older unconfirmed
  // entries were never charged, so they stay in History and not here.
  const unconfirmed = history.filter((r) => r.status === "unconfirmed" && r.attempt_id);
  if (!needs.length && !unconfirmed.length) {
    return (
      <LayerCard>
        <Empty icon={<CheckCircle size={40} />} title="Nothing needs your attention"
          description="Questions the extension couldn't answer and applications it couldn't confirm show up here." />
      </LayerCard>
    );
  }
  return (
    <div className="oj-stack">
      {needs.length ? (
        <section className="oj-stack" aria-labelledby="needs-title">
          <h2 className="oj-card-title" id="needs-title">Questions to answer</h2>
          <p className="oj-note">These forms asked something your settings don't cover. Your answers are saved and reused on later applications.</p>
          {needs.map((n) => <Questions key={n.attempt_id} need={n} reload={reload} />)}
        </section>
      ) : null}
      {unconfirmed.length ? (
        <section className="oj-stack" aria-labelledby="unconfirmed-title">
          <h2 className="oj-card-title" id="unconfirmed-title">Submission unconfirmed</h2>
          <Banner variant="alert" icon={<Info weight="fill" />} title="These count as applications for now"
            description="The extension pressed Submit, but the site never confirmed it got the application. Each one uses one application from your plan. If one didn't go through, dispute it within 14 days and you get that application back." />
          <LayerCard className="oj-table">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Job</Table.Head>
                  <Table.Head>Date</Table.Head>
                  <Table.Head><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {unconfirmed.map((r) => (
                  <Table.Row key={r.attempt_id || r.job_id}>
                    <Table.Cell><JobCell title={r.title} link={r.link} sub={[r.company, r.reason].filter(Boolean).join(" · ")} /></Table.Cell>
                    <Table.Cell className="oj-num">{fmtDate(r.at)}</Table.Cell>
                    <Table.Cell>
                      <div className="oj-actions">
                        {r.disputable && r.attempt_id ? <DisputeButton row={r} left={disputesLeft} reload={reload} /> : <span className="oj-note">Can't be disputed</span>}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        </section>
      ) : null}
    </div>
  );
}
