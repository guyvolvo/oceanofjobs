import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toasty } from "@cloudflare/kumo/components/toast";
import "@cloudflare/kumo/styles/standalone";
import "../app.css";
import "./account.css";
import { Account } from "./Account";

// A sign-in can land on any page (auth.js): Google's ?code=, GitHub's
// #id_token= or #auth_error=. The tokens have to be stored before the
// page decides whether the reader is signed in.
const redirect = typeof handleAuthRedirect === "function" ? handleAuthRedirect().catch(() => {}) : Promise.resolve();
redirect.finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Toasty>
        <Account />
      </Toasty>
    </StrictMode>,
  );
});
