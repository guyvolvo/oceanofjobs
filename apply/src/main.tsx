import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo/components/toast";
import "@cloudflare/kumo/styles/standalone";
import "./app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toasty>
      <App />
    </Toasty>
  </StrictMode>,
);
