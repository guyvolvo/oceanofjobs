// Settings: the address, the theme, log out, personal access tokens for
// MCP clients (api/tokens.py), and deleting the account.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Table } from "@cloudflare/kumo/components/table";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Plus } from "@phosphor-icons/react";
import { ApiError, api, send } from "../api";
import { useDark } from "../theme";
import { ConfirmDanger } from "../shared";
import { EMPTY_PROFILE, type Access, type Alert, type SavedRow, type Token } from "./data";
import { Card, ConfirmButton } from "./ui";

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

// The one line each client needs to add the server with the token, in the
// same order as the homepage's install tabs (docs/content/docs/mcp.mdx).
const MCP = "https://oceanofjobs.com/mcp";
const json = (tok: string) => JSON.stringify({ mcpServers: { oceanofjobs: { url: MCP, headers: { Authorization: `Bearer ${tok}` } } } });
const AGENTS: Record<string, { name: string; cmd: (tok: string) => string; where?: string }> = {
  cc: { name: "Claude Code", cmd: (tok) => `claude mcp add --transport http oceanofjobs ${MCP} --header "Authorization: Bearer ${tok}"` },
  cursor: { name: "Cursor", cmd: json, where: "Paste it into ~/.cursor/mcp.json." },
  vscode: { name: "VS Code", cmd: (tok) => `code --add-mcp '${JSON.stringify({ name: "oceanofjobs", type: "http", url: MCP, headers: { Authorization: `Bearer ${tok}` } })}'` },
  gemini: { name: "Gemini CLI", cmd: (tok) => `gemini mcp add -s user --transport http -H "Authorization: Bearer ${tok}" oceanofjobs ${MCP}` },
  codex: { name: "Codex", cmd: () => `codex mcp add oceanofjobs --url ${MCP} --bearer-token-env-var OOJ_TOKEN`, where: "Then set OOJ_TOKEN to the token above wherever you start Codex." },
  kimi: { name: "Kimi", cmd: json, where: "In Kimi Code, run /mcp-config and paste it, or add it to its mcp.json." },
};
const mask = (tok: string) => tok.slice(0, 12) + "…";

// What a token may do, per area (api/tokens.py AREAS).
const AREAS: [string, string][] = [["saved", "Saved jobs"], ["queue", "Auto apply queue"], ["alerts", "Alerts"], ["preferences", "Search preferences"]];
const ACCESS: Record<Access, string> = { none: "No access", read: "Read", write: "Read and write" };
const every = (a: Access) => Object.fromEntries(AREAS.map(([k]) => [k, a])) as Record<string, Access>;
type Perms = Record<string, Access>;
// Writing needs reading: Write ticks Read too, and clearing Read clears Write.
const withRead = (p: Perms, k: string, on: boolean): Perms => ({ ...p, [k]: on ? (p[k] === "write" ? "write" : "read") : "none" });
const withWrite = (p: Perms, k: string, on: boolean): Perms => ({ ...p, [k]: on ? "write" : p[k] === "none" ? "none" : "read" });

// The new token's permissions: a row per area, a column each for read and
// write, and a box at the top of each column for all of them.
function PermissionGrid({ perms, setPerms }: { perms: Perms; setPerms: (p: Perms) => void }) {
  const reads = AREAS.filter(([k]) => perms[k] !== "none").length;
  const writes = AREAS.filter(([k]) => perms[k] === "write").length;
  const all = (fn: typeof withRead, on: boolean) => setPerms(AREAS.reduce((p, [k]) => fn(p, k, on), perms));
  return (
    <table className="oj-perm-table">
      <caption className="oj-pref-label">Permissions</caption>
      <thead>
        <tr>
          <th scope="col">Permission</th>
          <th scope="col"><Checkbox label="Read all" checked={reads === AREAS.length} indeterminate={reads > 0 && reads < AREAS.length}
            onCheckedChange={(c) => all(withRead, c === true)} /></th>
          <th scope="col"><Checkbox label="Write all" checked={writes === AREAS.length} indeterminate={writes > 0 && writes < AREAS.length}
            onCheckedChange={(c) => all(withWrite, c === true)} /></th>
        </tr>
      </thead>
      <tbody>
        {AREAS.map(([k, label]) => (
          <tr key={k}>
            <th scope="row">{label}</th>
            <td><Checkbox aria-label={`Read ${label.toLowerCase()}`} checked={perms[k] !== "none"} onCheckedChange={(c) => setPerms(withRead(perms, k, c === true))} /></td>
            <td><Checkbox aria-label={`Write ${label.toLowerCase()}`} checked={perms[k] === "write"} onCheckedChange={(c) => setPerms(withWrite(perms, k, c === true))} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function canDo(p: Record<string, Access>) {
  const of = (a: Access) => AREAS.filter(([k]) => p[k] === a).map(([, label]) => label.toLowerCase());
  return (["write", "read"] as Access[]).map((a) => [a, of(a)] as const).filter(([, l]) => l.length)
    .map(([a, l]) => `${ACCESS[a]}: ${l.length === AREAS.length ? "everything" : l.join(", ")}`).join(" · ");
}

// Shown masked, so it stays out of screenshots and screen shares. Copy,
// or selecting it and pressing Ctrl+C, gives the whole value: a pasted
// "ooj_ZmEwMzAy…" adds a server that never works.
function Secret({ full, shown, label }: { full: string; shown: string; label: string }) {
  const toasts = useKumoToastManager();
  const [copied, setCopied] = useState(false);
  return (
    <div className="oj-secret">
      <code onCopy={(e) => { e.preventDefault(); e.clipboardData.setData("text/plain", full); }}>{shown}</code>
      <Button variant="secondary" aria-label={`Copy ${label}`} onClick={async () => {
        try {
          await navigator.clipboard.writeText(full);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toasts.add({ variant: "error", title: "Copy did not work. Select the text and copy it." });
        }
      }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

function Tokens() {
  const toasts = useKumoToastManager();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [perms, setPerms] = useState(every("read"));
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [made, setMade] = useState("");
  const [agent, setAgent] = useState("cc");
  const fail = (title: string) => toasts.add({ variant: "error", title });

  const load = useCallback(async () => {
    try {
      setTokens((await api<{ tokens: Token[] }>("/me/tokens")).tokens || []);
    } catch {
      fail("Couldn't load your tokens.");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ token: string }>("/me/tokens", send("POST", { name, expires_in_days: expiry ? Number(expiry) : null, permissions: perms }));
      setMade(res.token);
      setName("");
      setPerms(every("read"));
      setFormOpen(false);
      await load();
    } catch (err) {
      fail(/at most/.test((err as Error).message) ? "You can have five tokens. Revoke one first." : "Couldn't create the token. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await api(`/me/tokens/${id}`, { method: "DELETE" });
      toasts.add({ variant: "success", title: "Revoked. Apps using it lose access now." });
      await load();
    } catch {
      fail("Couldn't revoke that token. Try again.");
    } finally {
      setRevoking(null);
    }
  };
  const full = (tokens?.length || 0) >= 5;
  const a = AGENTS[agent];
  const nothing = AREAS.every(([k]) => perms[k] === "none");

  return (
    <Card title="Personal access tokens"
      action={<Button variant="primary" icon={<Plus />} disabled={full} title={full ? "Five tokens at most. Revoke one first." : undefined}
        onClick={() => setFormOpen(true)}>New token</Button>}>
      <Dialog.Root open={formOpen} onOpenChange={(o) => { if (!o) setFormOpen(false); }}>
        <Dialog className="oj-dialog oj-token-dialog">
          <Dialog.Title className="oj-card-title">New token</Dialog.Title>
          <form className="oj-stack" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <Input label="Token name" maxLength={60} placeholder="Name, e.g. Claude Code laptop" autoComplete="off" autoFocus
              value={name} onChange={(e) => setName(e.target.value)} />
            <Select className="oj-select" label="Expires" value={expiry} onValueChange={(v) => setExpiry(String(v ?? ""))}
              items={{ "30": "Expires in 30 days", "90": "Expires in 90 days", "": "Never expires" }} />
            <PermissionGrid perms={perms} setPerms={setPerms} />
            {nothing ? <p className="oj-error" role="alert">Give the token at least one permission.</p> : null}
            <div className="oj-row oj-dialog-actions">
              <Button variant="secondary" onClick={() => setFormOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={nothing}>Create token</Button>
            </div>
          </form>
        </Dialog>
      </Dialog.Root>
      {made ? (
        <div className="oj-stack oj-made">
          <p className="oj-note">Copy this token now. It will not be shown again.</p>
          <Secret full={made} shown={mask(made)} label="the token" />
          <p className="oj-note">Or add it to your AI client in one line:</p>
          <div className="oj-tabs">
            <Tabs variant="segmented" value={agent} onValueChange={setAgent}
              tabs={Object.entries(AGENTS).map(([value, x]) => ({ value, label: x.name }))} />
          </div>
          <Secret full={a.cmd(made)} shown={a.cmd(mask(made))} label="the command" />
          {a.where ? <p className="oj-note">{a.where}</p> : null}
          <p className="oj-note">Claude and ChatGPT connectors can't send a token yet, so the token doesn't work there.</p>
        </div>
      ) : null}
      {!tokens ? <div className="oj-row oj-note"><Loader /> Loading</div> : tokens.length ? (
        <div className="oj-table">
          <Table>
            <Table.Body>
              {tokens.map((t) => (
                <Table.Row key={t.id}>
                  <Table.Cell>
                    <span className="oj-job">{t.name}</span>
                    {t.permissions ? <span className="oj-sub">{canDo(t.permissions)}</span> : null}
                    <span className="oj-sub">{[`ends in ${t.hint}`, `made ${day(t.created_at)}`,
                      t.last_used_at ? `last used ${day(t.last_used_at)}` : "never used",
                      t.expires_at ? `expires ${day(t.expires_at)}` : "never expires"].join(" · ")}</span>
                  </Table.Cell>
                  <Table.Cell className="oj-actions-cell">
                    {/* The list holds the extension's token too, so one stray click could disconnect it. */}
                    <ConfirmButton ask="Revoke?" variant="ghost" loading={revoking === t.id} onConfirm={() => revoke(t.id)}>Revoke</ConfirmButton>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}

// Everything the account holds, one request at a time, then the profile
// emptied (an empty profile is the same shape as never having had one).
async function deleteEverything() {
  for (const a of (await api<{ alerts: Alert[] }>("/me/alerts")).alerts || []) await api(`/me/alerts/${a.alert_id}`, { method: "DELETE" });
  for (const r of (await api<{ saved: SavedRow[] }>("/me/saved")).saved || []) await api(`/me/saved/${encodeURIComponent(r.job_id)}`, { method: "DELETE" });
  // The auto apply profile, history and queue.
  await api("/me/apply", { method: "DELETE" });
  // Every token too: one left behind would keep working for an account
  // its owner believes is gone.
  for (const t of (await api<{ tokens: Token[] }>("/me/tokens")).tokens || []) await api(`/me/tokens/${t.id}`, { method: "DELETE" });
  // The resume, Workday password and AI key saved to cloud storage, and the
  // terms, newsletter and waitlist choices. A server from before these
  // routes answers 404, which means there is nothing there to delete.
  for (const path of ["/me/storage", "/me/consent"]) {
    await api(path, { method: "DELETE" }).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) throw e; });
  }
  await api("/me/profile", send("PUT", EMPTY_PROFILE));
}

export function Settings({ email, logOut }: { email: string; logOut: () => void }) {
  const toasts = useKumoToastManager();
  const dark = useDark();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    setAsking(false);
    setDeleting(true);
    try {
      await deleteEverything();
      toasts.add({ variant: "success", title: "Deleted. Signing out." });
      setTimeout(signOut, 1200);
    } catch {
      toasts.add({ variant: "error", title: "Couldn't finish deleting your account. Try again." });
      setDeleting(false);
    }
  };
  return (
    <div className="oj-stack">
      <Card>
        <div className="oj-row oj-row-between"><span className="oj-pref-text"><span className="oj-pref-label">Email</span><span className="oj-note oj-wrap">{email}</span></span></div>
        <div className="oj-row oj-row-between">
          <span className="oj-pref-label">Theme</span>
          {/* Clicks the header's own theme button, which owns the switch and the storage key. */}
          <Button variant="secondary" aria-label={`Switch to the ${dark ? "light" : "dark"} theme`}
            onClick={() => document.getElementById("hero-theme")?.click()}>{dark ? "Light" : "Dark"}</Button>
        </div>
        <div className="oj-row oj-row-between">
          <span className="oj-pref-label">Log out</span>
          <Button variant="secondary" onClick={logOut}>Log out</Button>
        </div>
      </Card>
      <Tokens />
      <Card title="Delete account" className="oj-danger-card"
        note="Deletes your alerts, saved jobs, skill profile, auto apply details and history, resume and settings saved to cloud storage, and access tokens. It doesn't cancel a paid plan, so cancel that through Paddle first. This can't be undone.">
        <div><Button variant="secondary" className="oj-danger-ghost" loading={deleting} onClick={() => setAsking(true)}>Delete account</Button></div>
        <ConfirmDanger open={asking} title="Delete your account?" confirm="Delete my account" onConfirm={del} onCancel={() => setAsking(false)}>
          This deletes your alerts, saved jobs, skill profile, auto apply details and history, resume and settings saved to cloud storage, and access tokens. This can't be undone.
        </ConfirmDanger>
      </Card>
    </div>
  );
}
