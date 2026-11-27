// Connecting the accounts. Each network needs the owner's own developer
// app first; its setup steps are shown until its keys are in .env.
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Copy } from "@/components/icons";
import { crm } from "../api";
import { Btn, Panel } from "../ui";
import { NET, type Account, type Network } from "./data";

function Code({ children }: { children: string }) {
  return (
    <span className="soc-code">
      <code>{children}</code>
      <Button variant="ghost" size="icon" aria-label="Copy" onClick={() => navigator.clipboard.writeText(children).then(() => toast.success("Copied"))}><Copy size={14} /></Button>
    </span>
  );
}

function steps(net: Network, redirect: string): ReactNode {
  if (net === "instagram") return (
    <ol>
      <li>In the Instagram app, switch the account to a professional account (Business or Creator) under Settings, Account type and tools.</li>
      <li>At <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com/apps</a>, create an app of type Business and add the Instagram product. Pick API setup with Instagram login.</li>
      <li>Under Set up Instagram business login, add this redirect URL: <Code>{redirect}</Code></li>
      <li>Under App roles, Roles, add your Instagram account as an Instagram tester, then accept the invite in Instagram under Settings, Website permissions, Apps and websites.</li>
      <li>Copy the Instagram app ID and Instagram app secret from the API setup page into .env as <Code>INSTAGRAM_APP_ID</Code> and <Code>INSTAGRAM_APP_SECRET</Code>. They aren't the Facebook app ID.</li>
    </ol>
  );
  if (net === "linkedin") return (
    <ol>
      <li>At <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noreferrer">linkedin.com/developers/apps</a>, create an app. LinkedIn asks for a company page to attach it to.</li>
      <li>On the Products tab, add Share on LinkedIn and Sign In with LinkedIn using OpenID Connect.</li>
      <li>On the Auth tab, add this redirect URL: <Code>{redirect}</Code></li>
      <li>Copy the Client ID and Primary Client Secret into .env as <Code>LINKEDIN_CLIENT_ID</Code> and <Code>LINKEDIN_CLIENT_SECRET</Code>.</li>
    </ol>
  );
  return (
    <ol>
      <li>At <a href="https://developers.tiktok.com/apps" target="_blank" rel="noreferrer">developers.tiktok.com/apps</a>, create an app and add Login Kit and Content Posting API.</li>
      <li>Turn on the scopes user.info.basic, user.info.stats, video.upload and video.list.</li>
      <li>Under Login Kit, add this redirect URI: <Code>{redirect}</Code></li>
      <li>Under URL properties, add the domain oceanofjobs.com. TikTok fetches photos from there. Send me the DNS record it gives you and I'll add it.</li>
      <li>Until TikTok reviews the app, use its Sandbox: add your TikTok account as a target user and use the Sandbox's keys.</li>
      <li>Copy the Client key and Client secret into .env as <Code>TIKTOK_CLIENT_KEY</Code> and <Code>TIKTOK_CLIENT_SECRET</Code>.</li>
    </ol>
  );
}

const NOTE: Record<Network, string> = {
  instagram: "Posts, comments and numbers. The connection renews itself.",
  linkedin: "Posts as you, not as a company page. LinkedIn ends the connection after 60 days, then connect again.",
  tiktok: "Videos and photos go to your TikTok drafts, and you post them from the app.",
};
const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 864e5);

export function Accounts({ accounts, keySet, callback, reload }: { accounts: Account[]; keySet: boolean; callback: string; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const connect = async (net: Network) => {
    setBusy(net);
    try { location.href = (await crm<{ url: string }>(`/social/connect/${net}`, "POST")).url; } catch (e) { toast.error((e as Error).message); setBusy(""); }
  };
  const disconnect = async (a: Account) => {
    if (!confirm(`Disconnect ${NET[a.network].name}? Scheduled posts to it will fail until you connect it again.`)) return;
    setBusy(a.network);
    try { await crm(`/social/accounts/${a.network}`, "DELETE"); reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  };
  return (
    <div className="crm-stack">
      {!keySet ? (
        <Alert variant="destructive"><AlertTitle>CRM_SOCIAL_KEY isn't set</AlertTitle>
          <AlertDescription>The CRM needs it to store the networks' sign-ins. Add it to .env and deploy the CRM again.</AlertDescription></Alert>
      ) : null}
      <div className="soc-accounts">
        {accounts.map((a) => {
          const Icon = NET[a.network].icon;
          const left = a.expires ? days(a.expires) : null;
          return (
            <Panel key={a.network}><div className="crm-card crm-stack">
              <div className="soc-account-head">
                <Icon size={22} />
                <h2>{NET[a.network].name}</h2>
                {a.connected ? <span className="soc-result soc-ok">Connected</span> : null}
              </div>
              {a.connected ? (
                <div className="soc-who">
                  {a.picture ? <img src={a.picture} alt="" /> : null}
                  <div><b>{a.name || a.handle}</b>{a.handle && a.name ? <span className="crm-sub">{a.handle}</span> : null}
                    {a.followers !== null ? <span className="crm-sub">{a.followers.toLocaleString()} followers</span> : null}</div>
                </div>
              ) : null}
              <p className="crm-note">{NOTE[a.network]}</p>
              {a.connected && a.network === "linkedin" && left !== null ? (
                <p className={left < 7 ? "soc-error" : "crm-note"}>{left > 0 ? `Connection ends in ${left} day${left === 1 ? "" : "s"}.` : "The connection ended. Connect again."}</p>
              ) : null}
              {a.error ? <p className="soc-error">{a.error}</p> : null}
              {!a.ready ? (
                <div className="soc-steps"><b>Set up the {NET[a.network].name} app</b>{steps(a.network, callback + a.network)}
                  <p className="crm-note">Then deploy the CRM again and connect here.</p></div>
              ) : (
                <div className="crm-row">
                  <Btn loading={busy === a.network} disabled={!keySet} onClick={() => connect(a.network)}>{a.connected ? "Connect again" : "Connect"}</Btn>
                  {a.connected ? <Button variant="ghost" disabled={busy === a.network} onClick={() => disconnect(a)}>Disconnect</Button> : null}
                </div>
              )}
            </div></Panel>
          );
        })}
      </div>
    </div>
  );
}
