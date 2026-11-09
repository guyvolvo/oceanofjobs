// The first screen: the claim, the extension card, a search box and two
// links at the left; at the right the two previews on one dither panel
// (the extension filling an application, then a Claude Code session using
// the MCP server) with the install lines under them.
//
// The previews are pictures of a product drawn once in JSX and played by
// the effects below, which move the same DOM the old page's scripts did
// (hidden, classes, text). React never re-renders those subtrees, so the
// two never fight. They play under reduced motion too, on purpose.
import { useEffect, useRef, useState } from "react";
import { copyText } from "./copy";

const OPENAI = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

// Icons from Simple Icons (CC0); Codex and Hermes Agent from Lobe Icons (MIT).
const ICONS: Record<string, string> = {
  cc: "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z",
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  chatgpt: OPENAI,
  cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  vscode: "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
  gemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  codex: "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  kimi: "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441",
};

const MCP_URL = "https://oceanofjobs.com/mcp";
type Client = { id: string; name: string; note?: string; cmd?: string; dim?: string; add?: { label: string; href: string }; copyLabel: string };
const CLIENTS: Client[] = [
  { id: "cc", name: "Claude Code", dim: "claude mcp add", cmd: ` --transport http oceanofjobs ${MCP_URL}`, copyLabel: "Copy the Claude Code install command" },
  { id: "claude", name: "Claude", note: "Customize → Connectors → Add custom connector, then paste:", cmd: MCP_URL, copyLabel: "Copy the MCP server URL" },
  { id: "chatgpt", name: "ChatGPT", note: "Settings → Apps & Connectors → Developer mode on → Create, then paste:", cmd: MCP_URL, copyLabel: "Copy the MCP server URL" },
  { id: "cursor", name: "Cursor", note: "Opens Cursor with the server filled in. You confirm there.", cmd: MCP_URL, copyLabel: "Copy the MCP server URL",
    add: { label: "Add to Cursor", href: "cursor://anysphere.cursor-deeplink/mcp/install?name=oceanofjobs&config=eyJ1cmwiOiJodHRwczovL29jZWFub2Zqb2JzLmNvbS9tY3AifQ==" } },
  { id: "vscode", name: "VS Code", note: "Opens VS Code with the server filled in. You confirm there.", cmd: MCP_URL, copyLabel: "Copy the MCP server URL",
    add: { label: "Add to VS Code", href: "vscode:mcp/install?%7B%22name%22%3A%22oceanofjobs%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Foceanofjobs.com%2Fmcp%22%7D" } },
  { id: "gemini", name: "Gemini CLI", dim: "gemini mcp add", cmd: ` --transport http oceanofjobs ${MCP_URL}`, copyLabel: "Copy the Gemini CLI install command" },
  { id: "codex", name: "Codex", dim: "codex mcp add", cmd: ` oceanofjobs --url ${MCP_URL}`, copyLabel: "Copy the Codex install command" },
  { id: "hermes", name: "Hermes Agent", dim: "hermes mcp add", cmd: ` oceanofjobs --url ${MCP_URL}`, copyLabel: "Copy the Hermes Agent install command" },
  { id: "kimi", name: "Kimi", dim: "kimi mcp add", cmd: ` --transport http oceanofjobs ${MCP_URL}`, copyLabel: "Copy the Kimi install command" },
];

const Arrow = () => <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>;

// The install tabs: click or arrow keys pick a client and show its pane.
// Each pane's button copies its line, then shows a tick for a moment.
function McpInstall() {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const live = useRef<HTMLSpanElement>(null);
  const say = (msg: string) => { const el = live.current; if (el) { el.textContent = ""; setTimeout(() => { el.textContent = msg; }, 50); } };
  const copy = (c: Client) => copyText((c.dim || "") + c.cmd, () => { setCopied(c.id); say("Copied"); setTimeout(() => setCopied(null), 1600); });
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CLIENTS.length) % CLIENTS.length;
    setTab(next);
    tabs.current[next]?.focus();
  };
  return (
    <div className="mcp-install" data-for="1" hidden>
      <div className="mcp-tabbar">
        <div className="mcp-tabs" role="tablist" aria-label="Connect your AI client">
          {CLIENTS.map((c, i) => (
            <button key={c.id} type="button" role="tab" className="mcp-tab" id={`mcp-tab-${c.id}`} aria-controls={`mcp-pane-${c.id}`} aria-selected={i === tab}
              aria-label={c.name} title={c.name} tabIndex={i === tab ? 0 : -1} ref={(el) => { tabs.current[i] = el; }} onClick={() => setTab(i)} onKeyDown={(e) => onKey(e, i)}>
              {c.id === "hermes"
                ? <span className="mcp-mask" style={{ "--icon": "url(/img/hermes-agent.svg)" } as React.CSSProperties} aria-hidden="true" />
                : <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d={ICONS[c.id]} fillRule={c.id === "codex" ? "evenodd" : undefined} /></svg>}
            </button>
          ))}
        </div>
        <a className="mcp-more" href="/docs/mcp#connect-a-client">More</a>
      </div>
      {CLIENTS.map((c, i) => (
        <div key={c.id} className="mcp-pane" role="tabpanel" id={`mcp-pane-${c.id}`} aria-labelledby={`mcp-tab-${c.id}`} hidden={i !== tab}>
          {c.note ? <div className="mcp-note">{c.note}</div> : null}
          <div className="mcp-line">
            {c.dim ? <span className="mcp-prompt" aria-hidden="true">$</span> : null}
            {c.add ? <><a className="mcp-add" href={c.add.href}>{c.add.label}<Arrow /></a><span className="mcp-or">or copy the URL</span></>
              : <span className="mcp-cmd">{c.dim ? <span className="mcp-dim">{c.dim}</span> : null}{c.cmd}</span>}
            <button type="button" className="mcp-copy" aria-label={c.copyLabel} onClick={() => copy(c)}>
              {copied === c.id
                ? <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                : <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
            </button>
          </div>
        </div>
      ))}
      <span className="sr-only" ref={live} role="status" aria-live="polite" />
    </div>
  );
}

const Field = ({ label, value, file }: { label: string; value: string; file?: boolean }) => (
  <div className="ext-f">
    <span className="ext-l">{label}<em>*</em></span>
    <span className={`ext-in${file ? " ext-file" : ""}`}>{file ? <span className="ext-file-btn">Upload file</span> : null}<span className="ext-v" data-v={value} /></span>
  </div>
);
const YesNo = ({ label, pick }: { label: string; pick: "Yes" | "No" }) => (
  <div className="ext-f">
    <span className="ext-l">{label}<em>*</em></span>
    <span className="ext-yn" data-pick={pick}><span data-opt="Yes">Yes</span><span data-opt="No">No</span></span>
  </div>
);

function ExtWindow() {
  return (
    <div className="ext-win" id="ext-win">
      <div className="mcp-tbar ext-tbar"><span className="mcp-lights"><i /><i /><i /></span><span className="ext-url"><svg viewBox="0 -960 960 960" width="11" height="11"><path d="M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm120-560h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80Z" /></svg>jobs.ashbyhq.com/openai/f2d8ed04-3c2f-4298-832b-dda7e1644c1b/application</span></div>
      <div className="ext-body">
        <div className="ext-page" data-page>
          <div className="ext-co"><svg className="ext-logo" viewBox="0 0 24 24" width="22" height="22"><path d={OPENAI} /></svg></div>
          <div className="ext-job">Enterprise Security Engineer, Vulnerability Management</div>
          <div className="ext-meta">San Francisco · Security · Hybrid · Full time</div>
          <div className="ext-tabs"><span>Overview</span><span className="is-on">Application</span></div>
          <div className="ext-form">
            <Field label="Legal Name" value="Emily Johnson" />
            <Field label="Email" value="emily.johnson@example.com" />
            <Field label="Resume" value="Emily_Johnson_Resume.pdf" file />
            <Field label="Phone Number" value="+1 415 555 0134" />
            <Field label="Where are you currently located?" value="San Francisco, CA" />
            <Field label="When can you start a new role?" value="12/01/2026" />
            <YesNo label="Are you authorized to work in the country where the job is located?" pick="Yes" />
            <YesNo label="Will you now or in the future require sponsorship for employment visa status in this country?" pick="No" />
            <YesNo label="Are you able to work from our US office three days per week?" pick="Yes" />
            <div className="ext-f">
              <span className="ext-l">Additional Information <span className="ext-ai" hidden>AI</span></span>
              <span className="ext-in ext-area"><span className="ext-v" data-v="I run vulnerability management for a fleet of 20,000 endpoints and cut our time to patch critical findings from 30 days to 7. I'd like to bring that work to securing OpenAI's enterprise environment." data-ai /></span>
            </div>
            <div className="ext-f"><span className="ext-l">Applicant Arbitration Agreement Acknowledgement<em>*</em></span><span className="ext-check" data-pick="yes"><span className="ext-box" />I acknowledge that I have opened, read, and understood the Arbitration Agreement.</span></div>
            <span className="ext-submit" data-submit>Submit Application</span>
          </div>
        </div>
        <div className="ext-done" data-done>
          <svg viewBox="0 0 20 20" width="40" height="40"><circle cx="10" cy="10" r="10" /><path d="M5.8 10.4l2.8 2.8 5.6-6" /></svg>
          <div className="ext-done-t">Application submitted</div>
          <div className="ext-done-s">Thanks for applying to OpenAI. We'll be in touch.</div>
        </div>
        <div className="ext-card">
          <div className="ext-card-head"><img src="/favicon.svg" width="14" height="14" alt="" />Ocean of Jobs</div>
          <div className="ext-card-msg" data-msg>Reading the form</div>
          <div className="ext-card-bar"><i data-bar /></div>
        </div>
      </div>
    </div>
  );
}

const JOBS = [
  ["01 · Senior Infrastructure & Reliability Engineer", "Stuut · NYC · hybrid · $250–300K", "11 days ago · open", "oceanofjobs.com/job/4bf1a29d080bf8b9"],
  ["02 · Senior Software Engineer, Platform Engineering", "Distributed Spectrum · NYC · onsite · $150–200K", "13 days ago · open", "oceanofjobs.com/job/17d0b368fe6d757f"],
  ["03 · Senior DevOps / Cloud Infrastructure Engineer", "Truelogic · New York · remote · contract", "4 days ago · open", "oceanofjobs.com/job/d111ecce4537b2a6"],
];

function McpWindow() {
  return (
    <div className="mcp-win" id="mcp-win">
      <div className="mcp-tbar"><span className="mcp-lights"><i /><i /><i /></span></div>
      <div className="mcp-body">
        <div className="mcp-session">
          <div className="mcp-ln mcp-user" data-s="user" hidden>&gt; <b>Senior DevOps and platform roles in New York, last two weeks</b></div>
          <div data-s="tool" hidden>
            <div className="mcp-ln"><span className="g">●</span> <span className="b">oceanofjobs - search_jobs</span> <span className="d">(MCP)</span><span className="w">(query: "devops platform", city: "New York", seniority: "senior", max_age_days: 14)</span></div>
            <div className="mcp-ln mcp-tl" data-s="result" hidden><span className="d">⎿</span>  3 matches <span className="d">(ctrl+o to expand)</span></div>
          </div>
          <div data-s="answer" hidden>
            <div className="mcp-ln"><span className="w">●</span> <span className="b">Senior DevOps &amp; platform roles · New York · last 14 days</span></div>
            <div className="mcp-jobs">
              {JOBS.map(([t, co, age, url]) => (
                <div key={t} className="mcp-job" data-s="row" hidden>
                  <div className="mcp-ln mcp-in"><span className="b">{t}</span></div>
                  <div className="mcp-ln mcp-in w">{co}</div>
                  <div className="mcp-ln mcp-in lav">{age}</div>
                  <div className="mcp-ln mcp-in w">{url}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mcp-ln" data-s="spin" hidden><span className="amb" data-glyph>✻</span> <span className="amb">Churning…</span> <span className="d">(esc to interrupt)</span></div>
          <div className="mcp-ln d" data-s="done" hidden>✻ Churned for 3s · done 1:30 PM</div>
        </div>
        <div className="mcp-input">
          <div className="mcp-rule" />
          <div className="mcp-prompt"><span className="d">❯ </span><span data-typed /><span className="mcp-caret" /></div>
          <div className="mcp-foot"><span className="amb">⏵⏵ auto mode on</span> (shift+tab to cycle)</div>
        </div>
      </div>
    </div>
  );
}

// The extension preview: each field fills from the profile in turn, the
// page scrolling to keep it in view, then the AI drafts the one answer the
// profile doesn't have, Submit is pressed and the page turns into the
// confirmation. A new show starts it over.
function wireExt(win: HTMLElement) {
  const q = <T extends HTMLElement>(s: string) => win.querySelector<T>(s)!;
  const body = q(".ext-body"), page = q("[data-page]"), msg = q("[data-msg]"), bar = q("[data-bar]"), submit = q("[data-submit]"), ai = q(".ext-ai");
  const vals = Array.from(win.querySelectorAll<HTMLElement>("[data-v], [data-pick]"));
  let run = 0;
  const wait = (ms: number, id: number) => new Promise<void>((ok, stop) => { setTimeout(() => { if (id === run) ok(); else stop(new Error("superseded")); }, ms); });
  const say = (text: string, pct: number) => { msg.textContent = text; bar.style.width = pct + "%"; };
  // Each action waits a random 20-100ms first, so it reads as the
  // extension working through a real page, not a recording.
  const lag = () => 20 + Math.random() * 80;
  // Only once a field would sit under the status card, so the company and
  // the job title stay in view for the first fields.
  const scrollTo = (el: HTMLElement) => {
    const room = body.clientHeight - 140;
    const y = Math.max(0, Math.min(el.offsetTop + el.offsetHeight - room, page.scrollHeight - body.clientHeight));
    page.style.transform = `translateY(${-y}px)`;
  };
  const reset = () => {
    for (const v of vals) {
      if (v.hasAttribute("data-pick")) { v.classList.remove("is-picked"); v.querySelectorAll(".is-picked").forEach((o) => o.classList.remove("is-picked")); }
      else { v.textContent = ""; (v.parentNode as HTMLElement).classList.remove("is-filled", "is-filling"); }
    }
    ai.hidden = true;
    submit.classList.remove("is-pressed");
    page.style.transform = "";
    win.classList.remove("is-done");
    say("Reading the form", 4);
  };
  // In about `steps` frames of 16ms, however long the text is.
  async function type(v: HTMLElement, id: number, steps: number) {
    if (v.hasAttribute("data-pick")) { await wait(lag(), id); (v.querySelector(`[data-opt="${v.getAttribute("data-pick")}"]`) || v).classList.add("is-picked"); return; }
    const text = v.getAttribute("data-v") || "", box = v.parentNode as HTMLElement, per = Math.max(1, Math.ceil(text.length / steps));
    box.classList.add("is-filling");
    for (let n = per; n < text.length + per; n += per) { v.textContent = text.slice(0, n); await wait(16, id); }
    box.classList.remove("is-filling");
    box.classList.add("is-filled");
  }
  async function play() {
    const id = ++run;
    reset();
    try {
      await wait(300, id);
      const area = q("[data-ai]"), cut = vals.indexOf(area);
      const plain = vals.slice(0, cut), after = vals.slice(cut + 1);
      for (let i = 0; i < plain.length; i++) {
        say(`Filling from your profile · ${i + 1} of ${plain.length}`, 8 + 62 * (i + 1) / plain.length);
        scrollTo(plain[i].closest(".ext-f")!);
        await wait(lag(), id);
        await type(plain[i], id, plain[i].closest(".ext-file") ? 1 : 8);
      }
      scrollTo(area.closest(".ext-f")!);
      say("Drafting an answer with AI", 76);
      await wait(450, id);
      ai.hidden = false;
      await type(area, id, 30);
      for (const v of after) { scrollTo(v.closest(".ext-f")!); await wait(lag(), id); await type(v, id, 1); }
      say("All fields filled. Submitting", 92);
      scrollTo(submit);
      await wait(350 + lag(), id);
      submit.classList.add("is-pressed");
      await wait(250, id);
      win.classList.add("is-done");
      say("Submitted · confirmed by OpenAI", 100);
      await wait(2000, id);
      win.dispatchEvent(new Event("hero:ended", { bubbles: true }));
    } catch { /* a newer run took over */ }
  }
  const hide = () => { run++; };
  win.addEventListener("hero:show", play);
  win.addEventListener("hero:hide", hide);
  return () => { run++; win.removeEventListener("hero:show", play); win.removeEventListener("hero:hide", hide); };
}

// The terminal: the prompt types for 2s, the tool call and a spinner
// appear, then the result and the three rows 120ms apart, and the spinner
// settles into "Churned". One rAF timeline, paused while the window is off
// screen or the tab is hidden, resumed where it left off.
function wireMcp(win: HTMLElement) {
  const q = <T extends HTMLElement>(s: string) => win.querySelector<T>(s)!;
  const typed = q("[data-typed]"), user = q('[data-s="user"]'), tool = q('[data-s="tool"]'), result = q('[data-s="result"]'),
    answer = q('[data-s="answer"]'), spin = q('[data-s="spin"]'), done = q('[data-s="done"]'), glyph = q("[data-glyph]"),
    rows = Array.from(win.querySelectorAll<HTMLElement>('[data-s="row"]'));
  const TEXT = "Senior DevOps and platform roles in New York, last two weeks";
  const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
  const T_SEND = 2000, T_ANS = 3000, T_GAP = 120;
  let start: number | null = null, paused = true, pausedAt = 0, raf = 0, finished = false;
  const enter = (el: HTMLElement) => { el.hidden = false; el.classList.add("mcp-fade"); void el.offsetWidth; el.classList.remove("mcp-fade"); };
  function frame(now: number) {
    if (paused) return;
    if (start === null) start = now;
    const t = now - start;
    if (t < T_SEND) typed.textContent = TEXT.slice(0, Math.floor(TEXT.length * t / T_SEND));
    if (t >= T_SEND && user.hidden) { typed.textContent = ""; enter(user); enter(tool); spin.hidden = false; }
    if (!spin.hidden) glyph.textContent = GLYPHS[Math.floor(t / 120) % GLYPHS.length];
    if (t >= T_ANS && answer.hidden) { enter(result); enter(answer); }
    rows.forEach((r, i) => { if (t >= T_ANS + (i + 1) * T_GAP && r.hidden) enter(r); });
    if (t >= T_ANS + 4 * T_GAP) {
      spin.hidden = true; enter(done); finished = true;
      win.dispatchEvent(new Event("hero:ended", { bubbles: true }));
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  const pause = () => { if (paused) return; paused = true; pausedAt = performance.now(); cancelAnimationFrame(raf); };
  const resume = () => {
    if (!paused || finished) return;
    paused = false;
    if (start !== null) start += performance.now() - pausedAt;
    raf = requestAnimationFrame(frame);
  };
  let onScreen = false, visible = !document.hidden;
  const sync = () => { if (onScreen && visible) resume(); else pause(); };
  const io = new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; sync(); }, { threshold: 0.1 });
  io.observe(win);
  const onVis = () => { visible = !document.hidden; sync(); };
  document.addEventListener("visibilitychange", onVis);
  // Shown again in the carousel: back to an empty prompt, and play.
  const show = () => {
    cancelAnimationFrame(raf); start = null; finished = false; paused = true; typed.textContent = "";
    for (const el of [user, tool, result, answer, spin, done, ...rows]) el.hidden = true;
    sync();
  };
  win.addEventListener("hero:show", show);
  return () => { cancelAnimationFrame(raf); io.disconnect(); document.removeEventListener("visibilitychange", onVis); win.removeEventListener("hero:show", show); };
}

// The carousel: each preview plays when shown and says "hero:ended" when
// done; while nobody has touched the controls, the next one comes 3.5s
// later. The old front card swings out and tucks in behind (CSS keyframes).
function wireStage(root: HTMLElement) {
  const slides = Array.from(root.querySelectorAll<HTMLElement>("[data-slide]"));
  const tabs = Array.from(root.querySelectorAll<HTMLElement>("[data-go]"));
  const installs = Array.from(root.querySelectorAll<HTMLElement>("[data-for]"));
  let cur = 0, auto = true, timer = 0;
  const win = (i: number) => slides[i].firstElementChild as HTMLElement;
  function show(i: number, byUser?: boolean) {
    if (byUser) auto = false;
    clearTimeout(timer);
    const was = cur;
    cur = (i + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle("is-on", k === cur));
    tabs.forEach((t, k) => t.setAttribute("aria-pressed", String(k === cur)));
    installs.forEach((b) => { b.hidden = Number(b.getAttribute("data-for")) !== cur; });
    if (was !== cur) {
      slides.forEach((s) => s.classList.remove("is-leaving"));
      void slides[was].offsetWidth;
      slides[was].classList.add("is-leaving");
      win(was).dispatchEvent(new Event("hero:hide"));
    }
    win(cur).dispatchEvent(new Event("hero:show"));
  }
  const ended = (e: Event) => { if (auto && e.target === win(cur)) timer = window.setTimeout(() => show(cur + 1), 3500); };
  root.addEventListener("hero:ended", ended);
  const clicks = [...tabs.map((t) => [t, () => show(Number(t.getAttribute("data-go")), true)] as const),
    ...Array.from(root.querySelectorAll<HTMLElement>("[data-step]")).map((b) => [b, () => show(cur + Number(b.getAttribute("data-step")), true)] as const)];
  clicks.forEach(([el, fn]) => el.addEventListener("click", fn));
  show(0);
  return () => { clearTimeout(timer); root.removeEventListener("hero:ended", ended); clicks.forEach(([el, fn]) => el.removeEventListener("click", fn)); };
}

function HeroStage() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current!;
    const offs = [wireExt(el.querySelector("#ext-win")!), wireMcp(el.querySelector("#mcp-win")!), wireStage(el)];
    return () => offs.forEach((off) => off());
  }, []);
  return (
    <div className="home-hero-stage" ref={root}>
      <div className="mcp-panel hero-stack" aria-hidden="true">
        <div className="hero-slide is-on" data-slide="ext"><ExtWindow /></div>
        <div className="hero-slide" data-slide="mcp"><McpWindow /></div>
      </div>
      <div className="hero-slide-nav">
        <button type="button" className="hero-slide-arrow" data-step="-1" aria-label="Previous preview"><svg viewBox="0 -960 960 960" width="18" height="18" aria-hidden="true"><path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z" /></svg></button>
        <button type="button" className="hero-slide-tab" data-go="0" aria-pressed="true">Browser extension</button>
        <button type="button" className="hero-slide-tab" data-go="1" aria-pressed="false">AI agents (MCP)</button>
        <button type="button" className="hero-slide-arrow" data-step="1" aria-label="Next preview"><svg viewBox="0 -960 960 960" width="18" height="18" aria-hidden="true"><path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" /></svg></button>
      </div>
      <div className="ext-install" data-for="0">
        <a className="home-pill" href="https://chromewebstore.google.com/detail/kihjppefdadlodaoecffiemijlielhdi" target="_blank" rel="noopener">Add to Chrome</a>
        <p>Free to install.</p>
      </div>
      <McpInstall />
    </div>
  );
}

export function Hero() {
  // An empty search opens the whole board at /board, not /board?search=.
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    if ((e.currentTarget.elements.namedItem("search") as HTMLInputElement).value.trim()) return;
    e.preventDefault();
    location.href = "/board";
  };
  return (
    <section className="home-hero" aria-labelledby="home-title">
      <div className="home-hero-grid">
        <div className="home-hero-text">
          <h1 id="home-title">Automate your<br />job search</h1>
          <div className="home-promo">
            <p className="home-promo-eyebrow"><span className="home-promo-icon" aria-hidden="true" />Try out the new free browser extension</p>
            <h2 className="home-promo-title">Apply 20x faster with auto apply</h2>
            <p className="home-promo-text">Fill repetitive job applications automatically and instantly.</p>
            <div className="home-promo-actions">
              <a className="home-promo-badge" href="https://chromewebstore.google.com/detail/kihjppefdadlodaoecffiemijlielhdi" target="_blank" rel="noopener"><img src="/img/chrome-web-store-badge.png" width="159" height="48" alt="Available in the Chrome Web Store" /></a>
              <a className="home-promo-link" href="/docs/extension">See docs</a>
            </div>
          </div>
          <form className="home-search" action="/board" role="search" onSubmit={submit}>
            <svg className="home-search-icon" viewBox="0 -960 960 960" width="22" height="22" aria-hidden="true"><path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z" /></svg>
            <input className="home-search-input" name="search" type="search" autoComplete="off" aria-label="Search jobs" placeholder="Find your perfect job" />
            <button className="home-search-go" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg></button>
          </form>
          <div className="mt-[18px] flex flex-wrap gap-2.5">
            <a className="home-docs" href="/docs">Docs<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9" /></svg></a>
            <a className="home-docs" href="#pricing">See pricing<svg className="home-down" viewBox="0 -960 960 960" width="16" height="16" aria-hidden="true"><path d="M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z" /></svg></a>
          </div>
        </div>
        <HeroStage />
      </div>
    </section>
  );
}
