// Types for mail.mjs, which the CRM's pages also import for the preview.
export function markdown(md: string): string;
export function text(md: string): string;
export function page(subject: string, bodyHtml: string, unsubscribe: string, footerAddress?: string, kind?: "newsletter" | "account", image?: string): string;
