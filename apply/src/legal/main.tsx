// /privacy, /terms and /refunds in the browser: the document is plain
// prerendered HTML, so only the header is hydrated. Each page's HTML names
// its document on the root (data-page), which `npm run dev` uses.
import { Header } from "../shell/Header";
import { hydrateIslands } from "../shell/hydrate";
import type { Doc } from "./Legal";

hydrateIslands({ header: Header }, import.meta.env.DEV
  ? () => import("./Legal").then(({ Legal }) => <Legal doc={document.getElementById("root")!.dataset.page as Doc} />)
  : undefined);
