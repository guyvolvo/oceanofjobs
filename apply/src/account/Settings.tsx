// /account/settings: the address, the theme, log out, personal access
// tokens for MCP clients (api/tokens.py), and deleting the account.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, api, send } from "../api";
import { LoadingButton, SelectField, TextField, useReturnFocus } from "../fields";
import { useTheme } from "../site/theme";
import { Workspace } from "../site/Workspace";
import { EMPTY_PROFILE, type Access, type Alert, type SavedRow, type Token } from "./data";
import { ACTIONS_CELL, Card, ConfirmButton, ERROR, gate, JOB, LABEL, Loading, NOTE, ROW, SettingsNav, STACK, SUB, SWITCH, TABLE, TEXT,
  type User } from "./ui";

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const DIALOG = "max-h-[calc(100dvh-32px)] overflow-y-auto sm:max-w-[640px]";

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
const NARROW = "w-[1%] whitespace-nowrap";
const some = (n: number) => (n === AREAS.length ? true : n > 0 ? "indeterminate" : false);
function PermissionGrid({ perms, setPerms }: { perms: Perms; setPerms: (p: Perms) => void }) {
  const reads = AREAS.filter(([k]) => perms[k] !== "none").length;
  const writes = AREAS.filter(([k]) => perms[k] === "write").length;
  const all = (fn: typeof withRead, on: boolean) => setPerms(AREAS.reduce((p, [k]) => fn(p, k, on), perms));
  const head = "inline-flex cursor-pointer items-center gap-2 font-normal";
  return (
    <div className={TABLE}>
      <p className={`${LABEL} mb-1.5`}>Permissions</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Permission</TableHead>
            <TableHead className={NARROW}><label className={head}><Checkbox checked={some(reads)} onCheckedChange={(c) => all(withRead, c === true)} />Read all</label></TableHead>
            <TableHead className={NARROW}><label className={head}><Checkbox checked={some(writes)} onCheckedChange={(c) => all(withWrite, c === true)} />Write all</label></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {AREAS.map(([k, label]) => (
            <TableRow key={k}>
              <TableCell className="text-foreground">{label}</TableCell>
              <TableCell className={NARROW}><Checkbox aria-label={`Read ${label.toLowerCase()}`} checked={perms[k] !== "none"} onCheckedChange={(c) => setPerms(withRead(perms, k, c === true))} /></TableCell>
              <TableCell className={NARROW}><Checkbox aria-label={`Write ${label.toLowerCase()}`} checked={perms[k] === "write"} onCheckedChange={(c) => setPerms(withWrite(perms, k, c === true))} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 rounded-md border bg-muted px-2.5 py-2 font-mono text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]"
        onCopy={(e) => { e.preventDefault(); e.clipboardData.setData("text/plain", full); }}>{shown}</code>
      <Button type="button" variant="outline" aria-label={`Copy ${label}`} onClick={async () => {
        try {
          await navigator.clipboard.writeText(full);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy did not work. Select the text and copy it.");
        }
      }}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  // Days, or "never" (a Select can't hold an empty value).
  const [expiry, setExpiry] = useState("90");
  const [perms, setPerms] = useState(every("read"));
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [made, setMade] = useState("");
  const [agent, setAgent] = useState("cc");
  const [editing, setEditing] = useState<Token | null>(null);
  const [editName, setEditName] = useState("");
  const [editPerms, setEditPerms] = useState(every("read"));
  const fail = (title: string) => toast.error(title);
  const backFromNew = useReturnFocus(formOpen);
  const backFromEdit = useReturnFocus(!!editing);

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
      const res = await api<{ token: string }>("/me/tokens", send("POST", { name, expires_in_days: expiry === "never" ? null : Number(expiry), permissions: perms }));
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
      toast.success("Revoked. Apps using it lose access now.");
      await load();
    } catch {
      fail("Couldn't revoke that token. Try again.");
    } finally {
      setRevoking(null);
    }
  };
  const startEdit = (t: Token) => {
    setEditing(t);
    setEditName(t.name);
    if (t.permissions) setEditPerms(t.permissions);
  };
  // The name, and for an AI agent's token what it may do. The token and its expiry stay.
  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`/me/tokens/${editing.id}`, send("PATCH", { name: editName, ...(editing.permissions ? { permissions: editPerms } : {}) }));
      toast.success("Token saved");
      setEditing(null);
      await load();
    } catch {
      fail("Couldn't save the token. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const editNothing = !!editing?.permissions && AREAS.every(([k]) => editPerms[k] === "none");
  const full = (tokens?.length || 0) >= 5;
  const a = AGENTS[agent];
  const nothing = AREAS.every(([k]) => perms[k] === "none");

  return (
    <Card title="Personal access tokens"
      action={<Button disabled={full} title={full ? "Five tokens at most. Revoke one first." : undefined}
        onClick={() => setFormOpen(true)}><Plus />New token</Button>}>
      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) setFormOpen(false); }}>
        <DialogContent className={DIALOG} onCloseAutoFocus={backFromNew}>
          <DialogTitle>New token</DialogTitle>
          <DialogDescription className="sr-only">Name the token, choose when it expires and what it may do.</DialogDescription>
          <form className={STACK} onSubmit={(e) => { e.preventDefault(); create(); }}>
            <TextField label="Token name" maxLength={60} placeholder="Name, e.g. Claude Code laptop" autoComplete="off" autoFocus
              value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField label="Expires" value={expiry} onValueChange={setExpiry}
              items={{ "30": "Expires in 30 days", "90": "Expires in 90 days", never: "Never expires" }} />
            <PermissionGrid perms={perms} setPerms={setPerms} />
            {nothing ? <p className={ERROR} role="alert">Give the token at least one permission.</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
              <LoadingButton type="submit" loading={busy} disabled={nothing}>Create token</LoadingButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className={DIALOG} onCloseAutoFocus={backFromEdit}>
          <DialogTitle>Edit token</DialogTitle>
          <DialogDescription className="sr-only">Rename the token{editing?.permissions ? " or change what it may do" : ""}.</DialogDescription>
          <form className={STACK} onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
            <TextField label="Token name" maxLength={60} autoComplete="off" autoFocus
              value={editName} onChange={(e) => setEditName(e.target.value)} />
            {editing?.permissions ? <PermissionGrid perms={editPerms} setPerms={setEditPerms} /> : null}
            {editNothing ? <p className={ERROR} role="alert">Give the token at least one permission.</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <LoadingButton type="submit" loading={busy} disabled={editNothing}>Save</LoadingButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {made ? (
        <div className={`${STACK} rounded-lg bg-[var(--ooj-green-tint)] p-3`} data-made>
          <p className={NOTE}>Copy this token now. It will not be shown again.</p>
          <Secret full={made} shown={mask(made)} label="the token" />
          <p className={NOTE}>Or add it to your AI client in one line:</p>
          <div className="overflow-x-auto [scrollbar-width:none]">
            <Tabs value={agent} onValueChange={setAgent} className="w-max max-w-none">
              <TabsList>{Object.entries(AGENTS).map(([value, x]) => <TabsTrigger key={value} value={value}>{x.name}</TabsTrigger>)}</TabsList>
            </Tabs>
          </div>
          <Secret full={a.cmd(made)} shown={a.cmd(mask(made))} label="the command" />
          {a.where ? <p className={NOTE}>{a.where}</p> : null}
          <p className={NOTE}>Claude and ChatGPT connectors can't send a token yet, so the token doesn't work there.</p>
        </div>
      ) : null}
      {!tokens ? <Loading /> : tokens.length ? (
        <div className={TABLE}>
          <Table>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <span className={JOB}>{t.name}</span>
                    {t.permissions ? <span className={SUB}>{canDo(t.permissions)}</span> : null}
                    <span className={SUB}>{[`ends in ${t.hint}`, `made ${day(t.created_at)}`,
                      t.last_used_at ? `last used ${day(t.last_used_at)}` : "never used",
                      t.expires_at ? `expires ${day(t.expires_at)}` : "never expires"].join(" · ")}</span>
                  </TableCell>
                  <TableCell className={ACTIONS_CELL}>
                    {/* The list holds the extension's token too, so one stray click could disconnect it. */}
                    <div className="flex flex-nowrap justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(t)}>Edit</Button>
                      <ConfirmButton ask="Revoke?" variant="ghost" size="sm" loading={revoking === t.id} onConfirm={() => revoke(t.id)}>Revoke</ConfirmButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}

// The newsletter: product updates and new features, opt-in (api/consent.py).
// Every newsletter email links here. A server without the route hides it.
function Newsletter() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ newsletter: boolean }>("/me/consent").then((s) => setOn(!!s.newsletter), () => setOn(null));
  }, []);
  if (on === null) return null;
  const toggle = async () => {
    setBusy(true);
    try {
      const s = await api<{ newsletter: boolean }>("/me/email", send("PUT", { newsletter: !on }));
      setOn(!!s.newsletter);
      toast.success(s.newsletter ? "Subscribed to product updates" : "Unsubscribed from product updates");
    } catch {
      toast.error("Couldn't change that. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${ROW} justify-between`} id="newsletter">
      <span className={TEXT}><span className={LABEL}>Product updates</span>
        <span className={NOTE}>Emails about new features and product updates. Job alerts are set separately.</span></span>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <Switch className={SWITCH} checked={on} disabled={busy}
          aria-label={on ? "Product update emails on. Turn them off" : "Product update emails off. Turn them on"} onCheckedChange={toggle} />
        <span aria-hidden="true">{on ? "On" : "Off"}</span>
      </label>
    </div>
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

const WHAT = "This deletes your alerts, saved jobs, skill profile, auto apply details and history, resume and settings saved to cloud storage, and access tokens.";

function Settings({ email }: { email: string }) {
  const [dark, toggleTheme] = useTheme();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const back = useReturnFocus(asking);
  const del = async () => {
    setAsking(false);
    setDeleting(true);
    try {
      await deleteEverything();
      toast.success("Deleted. Signing out.");
      setTimeout(signOut, 1200);
    } catch {
      toast.error("Couldn't finish deleting your account. Try again.");
      setDeleting(false);
    }
  };
  return (
    <div className={STACK}>
      <Card>
        <div className={`${ROW} justify-between`}><span className={TEXT}><span className={LABEL}>Email</span><span className={`${NOTE} [overflow-wrap:anywhere]`}>{email}</span></span></div>
        <Newsletter />
        <div className={`${ROW} justify-between`}>
          <span className={LABEL}>Theme</span>
          <Button variant="outline" aria-label={`Switch to the ${dark ? "light" : "dark"} theme`} onClick={toggleTheme}>{dark ? "Light" : "Dark"}</Button>
        </div>
        <div className={`${ROW} justify-between`}>
          <span className={LABEL}>Log out</span>
          <Button variant="outline" onClick={() => { signOut(); location.href = "/"; }}>Log out</Button>
        </div>
      </Card>
      <Tokens />
      <Card title="Delete account" className="border-destructive/40"
        note={`${WHAT} It doesn't cancel a paid plan, so cancel that under Billing first. This can't be undone.`}>
        <div><LoadingButton variant="outline" className="text-destructive" loading={deleting} onClick={() => setAsking(true)}>Delete account</LoadingButton></div>
        <Dialog open={asking} onOpenChange={(o) => { if (!o) setAsking(false); }}>
          <DialogContent onCloseAutoFocus={back}>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>{WHAT} This can't be undone.</DialogDescription>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button>
              <Button variant="destructive" onClick={del}>Delete my account</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  );
}

function SettingsPage({ who }: { who: User }) {
  return (
    <Workspace current="settings" title="Settings">
      <SettingsNav />
      <Settings email={who.email} />
    </Workspace>
  );
}

export default gate("settings", SettingsPage);
