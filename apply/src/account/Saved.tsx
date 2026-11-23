// /account/saved: the reader's stars from any device. The account stores
// the ids; the listings come from /api/jobs, so what shows is the live
// record, closed ones included (someone who saved a job wants to know it
// closed).
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { X } from "@phosphor-icons/react";
import { Workspace } from "../site/Workspace";
import { plural } from "../shared";
import { safeHref, useSaved, type Job } from "./data";
import { ACTIONS_CELL, Card, ConfirmButton, gate, JOB, Loading, NOTE, SUB, TABLE } from "./ui";

function Saved({ jobs, error, removing, remove }: {
  jobs: Job[] | null; error: string; removing: string | null; remove: (id: string) => void;
}) {
  return (
    <Card>
      {error ? <p className={NOTE}>{error}</p>
        : !jobs ? <Loading />
        : !jobs.length ? <p className={NOTE}>No saved jobs yet.</p>
        : (
          <div className={TABLE}>
            <Table>
              <TableBody>
                {jobs.map((j) => {
                  const where = [j.company_name || (j.company_domain || "").replace(/\.invalid$/, ""), j.location].filter(Boolean).join(" · ");
                  return (
                    <TableRow key={j.id}>
                      <TableCell>
                        <a className={JOB} href={safeHref(j.url)} target="_blank" rel="noopener">{j.title}</a>
                        {j.closed_at ? <> <span title="This listing is no longer open"><Badge variant="secondary">Closed</Badge></span></> : null}
                        <span className={SUB}>{where}</span>
                      </TableCell>
                      <TableCell className={ACTIONS_CELL}>
                        <ConfirmButton size="icon-sm" ask="Remove?" variant="ghost" title="Remove from saved"
                          aria-label={`Remove ${j.title} from saved`} disabled={removing === j.id} onConfirm={() => remove(j.id)}><X /></ConfirmButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
    </Card>
  );
}

function SavedPage() {
  const saved = useSaved();
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (id: string) => {
    setRemoving(id);
    if (!(await saved.remove(id))) toast.error("Couldn't remove that job. Try again.");
    setRemoving(null);
  };
  return (
    <Workspace current="saved" title="Saved jobs" note={!saved.jobs ? "" : saved.count ? plural(saved.count, "saved job") : "Nothing saved yet"}
      actions={<Button variant="ghost" asChild><a href="/board">Open the board</a></Button>}>
      <Saved jobs={saved.jobs} error={saved.error} removing={removing} remove={remove} />
    </Workspace>
  );
}

export default gate("saved", SavedPage);
