import { hydrate } from "../shell/hydrate";
import { StatsPage } from "./Stats";

// qb.js is a deferred classic script; it has run by DOMContentLoaded at the latest.
const start = () => hydrate(<StatsPage />);
if (typeof QB === "undefined") addEventListener("DOMContentLoaded", start, { once: true });
else start();
