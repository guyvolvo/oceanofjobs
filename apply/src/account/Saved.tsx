// Saved jobs: the reader's stars from any device. The account stores the
// ids; the listings come from /api/jobs, so what shows is the live record,
// closed ones included (someone who saved a job wants to know it closed).
import { Badge } from "@cloudflare/kumo/components/badge";
import { Table } from "@cloudflare/kumo/components/table";
import { Loader } from "@cloudflare/kumo/components/loader";
import { X } from "@phosphor-icons/react";
import { safeHref, type Job } from "./data";
import { Card, ConfirmButton } from "./ui";

export function Saved({ jobs, error, removing, remove }: {
  jobs: Job[] | null; error: string; removing: string | null; remove: (id: string) => void;
}) {
  return (
    <Card>
      {error ? <p className="oj-note">{error}</p>
        : !jobs ? <div className="oj-row oj-note"><Loader /> Loading</div>
        : !jobs.length ? <p className="oj-note">No saved jobs yet.</p>
        : (
          <div className="oj-table">
            <Table>
              <Table.Header>
                <Table.Row><Table.Head>Job</Table.Head><Table.Head><span className="sr-only">Remove</span></Table.Head></Table.Row>
              </Table.Header>
              <Table.Body>
                {jobs.map((j) => {
                  const where = [j.company_name || (j.company_domain || "").replace(/\.invalid$/, ""), j.location].filter(Boolean).join(" · ");
                  return (
                    <Table.Row key={j.id}>
                      <Table.Cell>
                        <a className="oj-job" href={safeHref(j.url)} target="_blank" rel="noopener">{j.title}</a>
                        {j.closed_at ? <> <span title="This listing is no longer open"><Badge variant="neutral">Closed</Badge></span></> : null}
                        <span className="oj-sub">{where}</span>
                      </Table.Cell>
                      <Table.Cell className="oj-actions-cell">
                        <ConfirmButton ask="Remove?" size="sm" variant="ghost" shape="square" title="Remove from saved"
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
