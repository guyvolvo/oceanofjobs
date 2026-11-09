// The plans, once, for the home page's pricing section and /pricing. The
// table (plans across, features down) and the phone's stacked cards both
// draw from here, so a limit changes in one place.

export type PlanKey = "free" | "basic" | "pro";

export type Plan = {
  key: PlanKey;
  name: string;
  badge?: string;
  price: string;
  // The phone card's one-line description and its "Everything in X, plus:".
  desc: string;
  plus?: string;
  // The phone card's list.
  features: string[];
  cta: { label: string; href: string; primary: boolean };
  // The line under the button; `deal` is set in bold.
  terms: { before?: string; deal?: string };
};

export const PLANS: Plan[] = [
  {
    key: "free", name: "Free", price: "$0",
    desc: "Fill applications yourself and try automatic applying.",
    features: ["Job board", "Custom alerts", "MCP & REST API access", "Unlimited application form filling",
      "10 automatic applications a month", "50 AI-generated answers a month"],
    cta: { label: "Get started", href: "/account", primary: false },
    terms: { before: "No credit card required." },
  },
  {
    key: "basic", name: "Basic", badge: "Best value", price: "$7.99",
    desc: "For a steady search, with an AI agent you set up.",
    plus: "Everything in Free, plus:",
    features: ["100 automatic applications a month", "300 AI-generated answers a month", "Customize your AI agent", "Skip reviewing AI answers"],
    cta: { label: "Start 7-day free trial", href: "/checkout?plan=basic", primary: true },
    terms: { before: "Then ", deal: "50% off your first month." },
  },
  {
    key: "pro", name: "Pro", price: "$24.99",
    desc: "For applying to dozens of jobs a day.",
    plus: "Everything in Basic, plus:",
    features: ["Up to 50 automatic applications a day", "3,000 AI-generated answers a month"],
    cta: { label: "Get Pro", href: "/checkout?plan=pro", primary: false },
    terms: { deal: "50% off your first month." },
  },
];

// The plan whose column is lifted in the table.
export const HOT_PLAN: PlanKey = "basic";

// The table's rows: true is included, false is not, a string is the limit.
export type Feature = { name: string; note?: string } & Record<PlanKey, boolean | string>;

export const FEATURES: Feature[] = [
  { name: "Job board", free: true, basic: true, pro: true },
  { name: "Custom alerts", free: true, basic: true, pro: true },
  { name: "MCP & REST API access", free: true, basic: true, pro: true },
  { name: "Application form filling", free: "Unlimited", basic: "Unlimited", pro: "Unlimited" },
  { name: "Automatic applications", free: "10/month", basic: "100/month", pro: "Up to 50/day (~1,500 a month)" },
  { name: "AI-generated answers based on your profile", note: "Using a customizable AI agent.", free: "50/month", basic: "300/month", pro: "3,000/month" },
  { name: "Use your own AI key", free: true, basic: true, pro: true },
  { name: "Customize your AI agent", free: false, basic: true, pro: true },
  { name: "Skip reviewing AI answers", note: "The extension uses new AI answers without asking you first.", free: false, basic: true, pro: true },
];

export const PRICING_INTRO = "Searching jobs, setting alerts, using the REST API, and connecting AI assistants through MCP are all free. The Ocean of Jobs browser extension fills out applications in your browser and can submit them for you. Filling is free on every plan; paid plans submit more.";

// /pricing's questions (frontend/pricing.html). The last answer ends in
// "refund policy", which the page links to /refunds.
export const FAQ: { q: string; a: string }[] = [
  { q: "What counts as an application?", a: "An application counts when the extension submits it. If the site doesn't confirm it got the application, it still counts, and you can refund the credit within 14 days if it didn't go through. A form the extension fills in and you submit yourself doesn't count, and neither does a job it skips, for example because a form asks a question you haven't answered. Unused applications don't roll over to the next month." },
  { q: "Do I need an AI subscription?", a: "No. The extension fills in forms using your profile and saved answers. Basic and Pro include AI answers to new questions. On Free, you can add your own API key from an AI provider, and any usage fees are charged by that provider." },
  { q: "Where is my resume stored?", a: "Your resume file stays in the browser extension on your device and is sent to the employer when you apply. If you add your resume to your AI agent, its text (not the file) is saved to your account so the AI can answer from it, and you can remove it at any time. Your profile and saved answers are stored in your Ocean of Jobs account, so you can access them from another computer." },
  { q: "Can I cancel or get a refund?", a: "You can cancel at any time under Billing in your account settings or from the link in your receipt. Your subscription remains active until the end of the period you've paid for. You're also eligible for a full refund within 14 days of any payment, subject to our refund policy." },
];
