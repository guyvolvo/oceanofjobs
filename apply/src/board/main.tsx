// /board in the browser: hydrates the prerendered empty board, then the
// store boots (Board.tsx).
import { hydrate } from "../shell/hydrate";
import { Board } from "./Board";

hydrate(<Board />);
