// /account/connect: an app (Claude, ChatGPT, an MCP client) asks to use the
// account. The user picks what it may do and allows it, and the browser
// goes back to the app with a code it trades for a token (api/oauth.py).
// Signed out, the page asks to sign in first and keeps the address.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, pub, send } from "../api";
import { LoadingButton } from "../fields";
import { Workspace } from "../site/Workspace";
import { AREAS, PermissionGrid, type Perms } from "./Settings";
import { Card, ERROR, gate, NOTE, STACK } from "./ui";

const FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource"];
const ISSUER = "https://oceanofjobs.com";
// What an assistant needs to help with a search, and nothing that applies for the user.
const START: Perms = Object.fromEntries(AREAS.map(([k]) => [k, ["saved", "alerts", "preferences"].includes(k) ? "write" : "read"]));

type App = { name: string; host: string; known: boolean };

function Connect() {
  const [ask] = useState(() => {
    const q = new URLSearchParams(location.search);
    return Object.fromEntries(FIELDS.map((k) => [k, q.get(k) || ""]));
  });
  const [app, setApp] = useState<App | null>(null);
  const [bad, setBad] = useState(false);
  const [perms, setPerms] = useState(START);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    if (!ask.client_id || !ask.redirect_uri) { setBad(true); return; }
    pub<App>(`/oauth/client?${new URLSearchParams({ client_id: ask.client_id, redirect_uri: ask.redirect_uri })}`)
      .then(setApp, () => setBad(true));
  }, [ask]);

  // Back to the app, which reads the code or the refusal from the address.
  const back = (q: Record<string, string>) => {
    const u = new URL(ask.redirect_uri);
    for (const [k, v] of Object.entries({ ...q, ...(ask.state ? { state: ask.state } : {}), iss: ISSUER })) u.searchParams.set(k, v);
    location.assign(u.toString());
  };
  const allow = async () => {
    setBusy(true);
    setFailed("");
    try {
      const { redirect } = await api<{ redirect: string }>("/me/oauth/authorize", send("POST", { ...ask, permissions: perms }));
      location.assign(redirect);
    } catch {
      setFailed("Couldn't connect it. Start again from the app.");
      setBusy(false);
    }
  };
  const nothing = AREAS.every(([k]) => perms[k] === "none");

  if (bad) {
    return <Card><p className={ERROR} role="alert">This link to connect an app isn't valid. Start again from the app.</p></Card>;
  }
  if (!app) return <Card><p className={NOTE}>Loading</p></Card>;
  return (
    <Card>
      <div className={STACK}>
        <p className="m-0 text-foreground">{app.name} wants to use your Ocean of Jobs account. Choose what it can do. You can change this or disconnect it in Settings.</p>
        {app.known ? null : (
          <p className={ERROR} role="alert">This sends access to {app.host}. Allow it only if you started this from {app.host}.</p>
        )}
        <PermissionGrid perms={perms} setPerms={setPerms} />
        {nothing ? <p className={ERROR} role="alert">Give it at least one permission.</p> : null}
        {failed ? <p className={ERROR} role="alert">{failed}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => back({ error: "access_denied" })}>Cancel</Button>
          <LoadingButton loading={busy} disabled={nothing} onClick={allow}>Allow</LoadingButton>
        </div>
      </div>
    </Card>
  );
}

function ConnectPage() {
  return (
    <Workspace current="settings" title="Connect an app">
      <Connect />
    </Workspace>
  );
}

export default gate("settings", ConnectPage);
