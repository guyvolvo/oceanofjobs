import { Header } from "../shell/Header";
import { hydrateIslands } from "../shell/hydrate";
import { NotFoundBody } from "./NotFound";

hydrateIslands({ header: Header, notfound: NotFoundBody }, import.meta.env.DEV
  ? () => import("./NotFound").then(({ NotFound }) => <NotFound />)
  : undefined);
