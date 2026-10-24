import { useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
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
            description={need.drafts?.[q] ? "The AI drafted this answer. Check it, change anything that isn't right, then save." : undefined}
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

// Every question answered, but the site checks that a person sends the
// form, so the extension stopped short of Submit. Filling it in again from
// the extension takes it off this list.
function Ready({ need }: { need: Need }) {
  return (
    <LayerCard>
      <div className="oj-card-body">
        <div>
          <JobLink title={need.title} link={need.link} />
          <span className="oj-sub">{need.company}</span>
        </div>
        <p className="oj-note">Ready to submit. This site checks that a person sends the form, so the extension stopped before Submit. Open the application, click Fill application in the extension, check the answers, then press the site's Submit button.</p>
        <div className="oj-row">
          <LinkButton variant="primary" href={need.link} target="_blank" rel="noopener">Open the application</LinkButton>
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
      toasts.add({ variant: "error", title: "Couldn't refund the credit", description: e instanceof ApiError && e.code === "not_disputable" ? e.message : "Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(p) => <Button {...p} variant="secondary" disabled={!left}>Refund credit</Button>} />
      <Dialog className="oj-dialog">
        <Dialog.Title className="oj-card-title">Refund the credit for this application?</Dialog.Title>
        <Dialog.Description className="oj-note">
          Use this if {row.title} at {row.company || "this company"} never received your application.
          The credit goes back to your plan and you can queue the job again. {plural(left, "refund")} left this month.
        </Dialog.Description>
        <div className="oj-row oj-dialog-actions">
          <Dialog.Close render={(p) => <Button {...p} variant="secondary">Cancel</Button>} />
          <Button variant="primary" loading={busy} onClick={dispute}>Refund credit</Button>
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
        <Empty icon={<CheckCircle size={40} />} title="Looks good" />
      </LayerCard>
    );
  }
  return (
    <div className="oj-stack">
      {needs.length ? (
        <section className="oj-stack" aria-labelledby="needs-title">
          <h2 className="oj-card-title" id="needs-title">Questions to answer</h2>
          <p className="oj-note">These forms asked something your settings don't cover. Your answers are saved and reused on later applications.</p>
          {needs.map((n) => (n.ready ? <Ready key={n.attempt_id} need={n} /> : <Questions key={n.attempt_id} need={n} reload={reload} />))}
        </section>
      ) : null}
      {unconfirmed.length ? (
        <section className="oj-stack" aria-label="Unconfirmed applications">
          <Banner variant="alert" icon={<Info weight="fill" />} title="Unconfirmed applications"
            description="The auto apply extension filled out the application for these jobs but couldn't confirm whether it went through. If an application didn't go through, click Refund credit within 14 days of applying." />
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
                        {r.disputable && r.attempt_id ? <DisputeButton row={r} left={disputesLeft} reload={reload} /> : <span className="oj-note">Can't be refunded</span>}
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
