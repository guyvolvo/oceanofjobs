// What the directory and a company's panel share: the API's shapes, the
// hiring-system names and the two localStorage keys the old page kept.
export type Row = { domain: string; n: number; new_7d?: number; name: string | null; ats: string | null; has_logo?: boolean; trend?: (number | null)[] };
export type Directory = { companies: Row[]; capped?: boolean; as_of?: string };
export type Country = { value: string; label: string; n: number };
export type Profile = {
  domain: string; name: string | null; ats: string | null; has_logo?: boolean; tracked_since?: string;
  open_jobs: number; new_jobs_7d: number; history?: { day: string; open_n: number; new_n: number }[];
};
export type Facets = {
  categories?: { value: string; n: number }[];
  locations?: { value: string; label: string; n: number; cities?: { value: string; n: number }[] }[];
};
export type Job = { id: string; title: string; location: string | null; posted_at: string | null };
export type Jobs = { jobs: Job[]; total?: number };

export const COUNTRY_KEY = "iljobs_dir_country";
export const FOLLOW_KEY = "iljobs_dir_follow";

const ATS: Record<string, string> = {
  greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", smartrecruiters: "SmartRecruiters",
  workable: "Workable", comeet: "Comeet", recruitee: "Recruitee", personio: "Personio", teamtailor: "Teamtailor",
  bamboohr: "BambooHR", breezy: "Breezy", jazzhr: "JazzHR", pinpoint: "Pinpoint", oracle: "Oracle", eightfold: "Eightfold",
  hunter: "Hunter", jobvite: "Jobvite", hibob: "HiBob", gem: "Gem", successfactors: "SuccessFactors",
};
// A scraper of our own is named for the company it reads (tycowp,
// niloosoft, apple...). To a reader those are all one thing, the
// company's own website, so they count, filter and read as one.
export const atsKey = (a: string | null | undefined) => (a ? (ATS[a] ? a : "custom") : null);
export const atsName = (a: string | null | undefined) => (a ? ATS[a] || "Company website" : "Unknown");
export const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString();
export const age = (iso: string | null) => {
  if (!iso) return "";
  const hrs = (Date.now() - new Date(iso).getTime()) / 36e5;
  return hrs < 1 ? "just now" : hrs < 24 ? `${Math.floor(hrs)}h ago` : `${Math.floor(hrs / 24)}d ago`;
};
export const countryQuery = (country: string) => (country ? `&country=${encodeURIComponent(country)}` : "");
