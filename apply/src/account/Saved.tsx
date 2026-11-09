// /account/saved: the reader's stars from any device. The account stores
// the ids; the listings come from /api/jobs, so what shows is the live
// record, closed ones included (someone who saved a job wants to know it
// closed).
import { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Table } from "@cloudflare/kumo/components/table";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { X } from "@phosphor-icons/react";
import { Workspace } from "../site/Workspace";
import { plural, safeHref, useSaved, type Job } from "./data";
import { ACTIONS_CELL, Card, ConfirmButton, gate, JOB, NOTE, ROW, SUB, TABLE } from "./ui";

function Saved({ jobs, error, removing, remove }: {
  jobs: Job[] | null; error: string; removing: string | null; remove: (id: string) => void;
}) {
  return (
    <Card>
      {error ? <p className={NOTE}>{error}</p>
        : !jobs ? <div className={`${ROW} ${NOTE}`}><Loader /> Loading</div>
        : !jobs.length ? <p className={NOTE}>No saved jobs yet.</p>
        : (
          <div className={TABLE}>
            <Table>
              <Table.Body>
                {jobs.map((j) => {
                  const where = [j.company_name || (j.company_domain || "").replace(/\.invalid$/, ""), j.location].filter(Boolean).join(" · ");
                  return (
                    <Table.Row key={j.id}>
                      <Table.Cell>
                        <a className={JOB} href={safeHref(j.url)} target="_blank" rel="noopener">{j.title}</a>
                        {j.closed_at ? <> <span title="This listing is no longer open"><Badge variant="secondary">Closed</Badge></span></> : null}
                        <span className={SUB}>{where}</span>
                      </Table.Cell>
                      <Table.Cell className={ACTIONS_CELL}>
                        <ConfirmButton size="sm" ask="Remove?" variant="ghost" shape="square" title="Remove from saved"
                          aria-label={`Remove ${j.title} from saved`} disabled={removing === j.id} onConfirm={() => remove(j.id)}><X /></ConfirmButton>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
    </Card>
  );
}

function SavedPage() {
  const toasts = useKumoToastManager();
  const saved = useSaved();
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (id: string) => {
    setRemoving(id);
    if (!(await saved.remove(id))) toasts.add({ variant: "error", title: "Couldn't remove that job. Try again." });
    setRemoving(null);
  };
  return (
    <Workspace current="saved" title="Saved jobs" note={!saved.jobs ? "" : saved.count ? plural(saved.count, "saved job") : "Nothing saved yet"}
      actions={<LinkButton variant="ghost" href="/board">Open the board</LinkButton>}>
      <Saved jobs={saved.jobs} error={saved.error} removing={removing} remove={remove} />
    </Workspace>
  );
}

export default gate("saved", SavedPage);
