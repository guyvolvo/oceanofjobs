// The Chrome extension, two ways. Its content script (extension/
// connect.js, on every oceanofjobs.com page at document_start) marks
// <html data-ooj-extension="1"> and takes a token by postMessage; that is
// how a reader connects it. Newer builds also list this site under
// externally_connectable, so chrome.runtime.sendMessage reaches them
// directly: ping for status, applyNext to open the next queued job.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

// The Web Store build's id. An unpacked copy has another one, which its
// content script (1.9.2 on) writes to <html data-ooj-extension-id>.
const STORE_ID = "kihjppefdadlodaoecffiemijlielhdi";
const extId = () => document.documentElement.dataset.oojExtensionId || STORE_ID;

type Runtime = { sendMessage: (id: string, msg: object, cb: (res: unknown) => void) => void; lastError?: { message?: string } };
const runtime = (): Runtime | undefined => (window as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime;

export function ask<T>(msg: object, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const rt = runtime();
    if (!rt?.sendMessage) return reject(new Error("unavailable"));
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    try {
      rt.sendMessage(extId(), msg, (res) => {
        clearTimeout(timer);
        const err = rt.lastError;
        if (err || !res) reject(new Error(err?.message || "no answer"));
        else resolve(res as T);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

export type Ext = {
  checking: boolean;
  installed: boolean; // the content script marked the page, or ping answered
  bridge: boolean; // ping answered, so applyNext works
  version?: string;
  connected?: boolean; // from ping, or true once the content script says so
  justConnected?: boolean;
};

const marked = () => document.documentElement.dataset.oojExtension === "1";

export function useExtension(): Ext {
  const [ext, setExt] = useState<Ext>({ checking: true, installed: marked(), bridge: false });
  const check = useCallback(() => {
    ask<{ ok?: boolean; version?: string; connected?: boolean }>({ type: "ping" })
      .then((r) => {
        if (!r.ok) throw new Error("no");
        setExt((e) => ({ ...e, checking: false, installed: true, bridge: true, version: r.version, connected: !!r.connected || !!e.justConnected }));
      })
      .catch(() => setExt((e) => ({ ...e, checking: false, installed: marked(), bridge: false })));
  }, []);
  useEffect(() => {
    check();
    // The content script can land after this runs; look again, as the
    // account page did.
    const late = setTimeout(() => setExt((e) => (e.installed || !marked() ? e : { ...e, installed: true })), 1500);
    // Installed or updated in another tab, then back here.
    addEventListener("focus", check);
    const onMsg = (e: MessageEvent) => {
      if (e.source === window && e.origin === location.origin && e.data?.type === "ooj:connected") {
        setExt((x) => ({ ...x, installed: true, connected: true, justConnected: true }));
        check();
      }
    };
    addEventListener("message", onMsg);
    return () => { clearTimeout(late); removeEventListener("focus", check); removeEventListener("message", onMsg); };
  }, [check]);
  return ext;
}

// The account page's connect flow, moved here: mint an "extension" token
// and hand it to the content script, which only listens on this origin.
// The token is never shown or logged.
export async function connectExtension() {
  const made = await api<{ token: string }>("/me/tokens", {
    method: "POST", body: JSON.stringify({ name: "Chrome extension", expires_in_days: null, scope: "extension" }),
  });
  window.postMessage({ type: "ooj:connect", token: made.token }, location.origin);
}
