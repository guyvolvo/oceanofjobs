// Pure helpers: no DOM, no chrome.*. Loaded by the service worker
// (importScripts), injected next to the ATS fillers, and required by the
// node tests, hence the plain-script shape instead of an ES module.
(function (root) {
  const SYNONYMS = [
    [/\bauthorised\b/g, 'authorized'],
    [/\bauthorisation\b/g, 'authorization'],
    [/\bvisa sponsorship\b/g, 'sponsorship'],
    [/\bimmigration sponsorship\b/g, 'sponsorship'],
    [/\bu s( a)?\b/g, 'us'],
    [/\bunited states( of america)?\b/g, 'us'],
    [/\bcv\b/g, 'resume'],
  ];

  function normalise(text) {
    let s = String(text == null ? '' : text).toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    for (const [re, to] of SYNONYMS) s = s.replace(re, to);
    return s.replace(/\s+/g, ' ').trim();
  }

  // Greenhouse's own field names come first, they never change between boards.
  const BY_NAME = {
    first_name: 'first_name', last_name: 'last_name', preferred_name: 'preferred_name',
    email: 'email', phone: 'phone', candidate_location: 'location', 'candidate-location': 'location',
    resume: 'resume', cover_letter: 'cover_letter',
    gender: 'gender', race: 'race', hispanic_ethnicity: 'hispanic',
    veteran_status: 'veteran', disability_status: 'disability',
    // The phone field's country picker.
    country: 'phone_country',
  };

  // Order matters: "require sponsorship to work" must not read as authorization.
  const BY_LABEL = [
    [/linkedin/, 'linkedin'],
    [/github/, 'github'],
    [/sponsor/, 'sponsorship'],
    [/authorized to work|work authorization|eligible to work|right to work|legally (able|permitted) to work/, 'work_auth'],
    [/salary|compensation expectation|expected (pay|compensation)|desired (pay|compensation)/, 'salary'],
    [/notice period|earliest .*start|when can you start|available to start|start date/, 'notice'],
    [/preferred (first )?name/, 'preferred_name'],
    [/^(personal |other )?(website|portfolio|blog)( url| link)?$/, 'website'],
    [/^gender\b/, 'gender'],
    [/hispanic|latino/, 'hispanic'],
    [/^(race|ethnicity)\b/, 'race'],
    [/\bveteran\b/, 'veteran'],
    [/\bdisability\b/, 'disability'],
  ];

  // Never sent to an AI provider: the user sets these or they stay blank.
  const EEO = new Set(['gender', 'race', 'hispanic', 'veteran', 'disability']);

  function classify(field) {
    if (BY_NAME[field.name]) return BY_NAME[field.name];
    const label = normalise(field.label);
    for (const [re, key] of BY_LABEL) if (re.test(label)) return key;
    return null;
  }

  const blank = (v) => (v == null || String(v).trim() === '' ? undefined : String(v));
  const yesNo = (b) => (b === true ? 'Yes' : b === false ? 'No' : undefined);

  function countryOf(location) {
    const parts = String(location || '').split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : undefined;
  }

  function workAuth(work, job) {
    const mine = (work.authorized_countries || []).map((c) => c.toUpperCase());
    const theirs = String((job && job.country) || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (!mine.length || !theirs.length) return undefined;
    if (theirs.every((c) => mine.includes(c))) return 'Yes';
    if (!theirs.some((c) => mine.includes(c))) return 'No';
    return undefined;
  }

  function profileValue(key, profile, job) {
    const c = profile.contact || {}, l = profile.links || {}, w = profile.work || {}, e = profile.eeo || {};
    switch (key) {
      case 'first_name': case 'preferred_name': return blank(c.first_name);
      case 'last_name': return blank(c.last_name);
      case 'email': return blank(c.email);
      case 'phone': return blank(c.phone);
      case 'location': return blank(c.location);
      case 'phone_country': return countryOf(c.location);
      case 'linkedin': return blank(l.linkedin);
      case 'github': return blank(l.github);
      case 'website': return blank(l.website);
      case 'salary': return blank(w.salary);
      case 'notice': return blank(w.notice_period);
      case 'sponsorship': return yesNo(w.needs_sponsorship);
      case 'work_auth': return workAuth(w, job);
      case 'gender': case 'race': case 'veteran': case 'disability': return blank(e[key]);
      case 'hispanic': {
        const race = blank(e.race);
        if (!race) return undefined;
        if (normalise(race) === 'decline') return 'decline';
        return /hispanic|latin/.test(normalise(race)) ? 'Yes' : 'No';
      }
      default: return undefined;
    }
  }

  // Words that change the phrasing of a question but not what it asks.
  const FILLER = new Set('a an the please currently legally now ever any your do does are is be to of in on for and or at this that'.split(' '));

  function sameQuestion(a, b) {
    const A = new Set(a.split(' ')), B = new Set(b.split(' '));
    for (const w of A) if (!B.has(w) && !FILLER.has(w)) return false;
    for (const w of B) if (!A.has(w) && !FILLER.has(w)) return false;
    return true;
  }

  // Same normalised text, or the same words give or take filler. A company
  // name is never filler, so "worked for Figma" does not answer "worked
  // for Airbnb".
  function findAnswer(question, answers) {
    const q = normalise(question);
    if (!q) return undefined;
    const usable = (answers || []).filter((a) => blank(a.answer) !== undefined);
    const exact = usable.find((a) => normalise(a.question) === q);
    if (exact) return String(exact.answer);
    const near = usable.find((a) => sameQuestion(q, normalise(a.question)));
    return near ? String(near.answer) : undefined;
  }

  const DECLINE = /decline|dont wish|do not wish|prefer not|choose not|rather not|not to (answer|disclose|say|self identify)/;

  // Index of the option that says what `answer` says, or -1. A loose match
  // that fits two options is no match: "protected veteran" is in both "I am
  // a protected veteran" and "I am not a protected veteran".
  function pickOption(options, answer) {
    const want = normalise(answer);
    if (!want) return -1;
    const opts = options.map(normalise);
    const only = (test) => {
      const hits = opts.map((o, i) => (test(o) ? i : -1)).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    };
    if (want === 'decline') return opts.findIndex((o) => DECLINE.test(o));
    const exact = opts.indexOf(want);
    if (exact >= 0) return exact;
    if (want === 'yes' || want === 'no') return opts.findIndex((o) => o.split(' ')[0] === want);
    const start = only((o) => o.startsWith(want + ' ') || want.startsWith(o + ' '));
    return start >= 0 ? start : only((o) => (' ' + o + ' ').includes(' ' + want + ' '));
  }

  // fields: [{name, label, required, type, options}] as an ATS filler reads
  // them. Returns what to type where, and the required ones nobody answered.
  function planFill(fields, profile, job) {
    const fills = [], missing = [];
    for (const f of fields) {
      const key = classify(f);
      if (key === 'resume') { fills.push({ ...f, key, value: 'cv' }); continue; }
      if (key === 'cover_letter') { if (f.required) missing.push({ ...f, key }); continue; }
      let value = key ? profileValue(key, profile, job) : undefined;
      if (value === undefined) value = findAnswer(f.label, profile.answers);
      if (value !== undefined && f.options && f.options.length && pickOption(f.options, value) < 0) value = undefined;
      if (value === undefined) { if (f.required) missing.push({ ...f, key }); continue; }
      fills.push({ ...f, key, value });
    }
    return { fills, missing };
  }

  function isEeo(field) {
    return EEO.has(field.key || classify(field));
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function appliedToday(history, now) {
    const today = new Date(now);
    return (history || []).filter((h) => h.status === 'submitted' && sameDay(new Date(h.at), today)).length;
  }

  function isBlocked(domain, blocked) {
    const d = String(domain || '').toLowerCase();
    return (blocked || []).some((b) => {
      const x = String(b).toLowerCase().replace(/^www\./, '');
      return x && (d === x || d.endsWith('.' + x));
    });
  }

  // Why a job should not be applied to, or null. ctx: {history, guardrails,
  // now, retrySkipped, minMatch}. retrySkipped is for queue mode, where the
  // user approved the job and may since have added the missing answer.
  function screenJob(job, ctx) {
    const g = ctx.guardrails || {};
    const history = ctx.history || [];
    const mine = history.filter((h) => h.job_id === job.id);
    if (mine.some((h) => h.status === 'submitted')) return 'already applied';
    if (!ctx.retrySkipped && mine.length) return 'already tried';
    if (isBlocked(job.company_domain, g.blocked_companies)) return 'blocked company';
    const days = g.one_per_company_days;
    if (days > 0) {
      const since = ctx.now - days * 864e5;
      const recent = history.some((h) => h.status === 'submitted' && h.company === job.company_domain && Date.parse(h.at) >= since);
      if (recent) return 'applied to this company recently';
    }
    if (ctx.minMatch != null && (job.match_score || 0) < ctx.minMatch) return 'below your minimum match';
    return null;
  }

  // Jobs that pass screenJob, at most one per company when the user limits that.
  function pickJobs(jobs, ctx) {
    const seen = new Set();
    const perCompany = (ctx.guardrails || {}).one_per_company_days > 0;
    return jobs.filter((j) => {
      if (screenJob(j, ctx)) return false;
      if (perCompany && seen.has(j.company_domain)) return false;
      seen.add(j.company_domain);
      return true;
    });
  }

  // How many more applications this run may send.
  function budget(usage, history, guardrails, now, perRun) {
    let left = Math.min(usage.remaining, perRun);
    const daily = (guardrails || {}).daily_limit;
    if (daily != null) left = Math.min(left, daily - appliedToday(history, now));
    return Math.max(0, left);
  }

  const api = {
    normalise, classify, profileValue, findAnswer, pickOption, planFill, isEeo,
    appliedToday, isBlocked, screenJob, pickJobs, budget, countryOf,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.oojMatch = api;
})(globalThis);
