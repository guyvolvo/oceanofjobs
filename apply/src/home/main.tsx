// / in the browser: the page is prerendered HTML (Home.tsx); only its
// islands are hydrated.
import { Header } from "../shell/Header";
import { hydrateIslands } from "../shell/hydrate";
import { ApiCode } from "./ApiSample";
import { HeroSearch, HeroStage } from "./Hero";
import { HotJobs } from "./HotJobs";
import { LogoBand } from "./LogoBand";
import { Poll } from "./Poll";
import "./home.css";

hydrateIslands({ header: Header, "hero-search": HeroSearch, "hero-stage": HeroStage, "logo-band": LogoBand, "hot-jobs": HotJobs, "api-code": ApiCode, poll: Poll },
  import.meta.env.DEV ? () => import("./Home").then(({ Home }) => <Home />) : undefined);
