import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import "../styles/app.css";
import "./crm.css";
import { App } from "./App";

// Dark unless the owner picked light here (the CRM has its own host, so
// the site's theme choice isn't visible to it).
try {
  if (localStorage.getItem("crm_theme") === "light") document.documentElement.dataset.mode = "light";
} catch { /* storage blocked: dark */ }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster position="bottom-right" />
  </StrictMode>,
);
