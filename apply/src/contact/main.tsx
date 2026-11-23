// /contact in the browser: the header and the form are hydrated; the
// intro and the direct ways stay prerendered HTML.
import { Header } from "../shell/Header";
import { hydrateIslands } from "../shell/hydrate";
import { ContactForm } from "./ContactForm";

hydrateIslands({ header: Header, "contact-form": ContactForm }, import.meta.env.DEV
  ? () => import("./Contact").then(({ Contact }) => <Contact />)
  : undefined);
