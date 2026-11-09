// /privacy, /terms and /refunds in the browser. Each page's HTML names its
// document on the root (data-page), the same name the prerender used.
import { hydrate } from "../shell/hydrate";
import { Legal, type Doc } from "./Legal";

hydrate(<Legal doc={document.getElementById("root")!.dataset.page as Doc} />);
