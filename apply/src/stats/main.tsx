import { Workspace } from "../site/Workspace";
import { boot } from "../site/boot";
import { StatsPage } from "./Stats";

boot(<Workspace current="stats" title="Statistics"><StatsPage /></Workspace>);
