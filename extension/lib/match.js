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
    // Ashby's system fields.
    _systemfield_name: 'full_name', _systemfield_email: 'email',
    _systemfield_resume: 'resume', _systemfield_location: 'location',
    // Workable's.
    firstname: 'first_name', lastname: 'last_name', address: 'location',
  };

  // Order matters: "require sponsorship to work" must not read as authorization.
  const BY_LABEL = [
    [/linkedin/, 'linkedin'],
    [/github/, 'github'],
    [/sponsor/, 'sponsorship'],
    [/authorized to work|work authorization|eligible to work|right to work|legally (able|permitted) to work/, 'work_auth'],
    [/salary|compensation expectation|expected (pay|compensation)|desired (pay|compensation)|salario|sueldo|expectativa (económica|salarial)|salaire|prétentions? salariales?|gehalt|gehaltsvorstellung|stipendio|\bral\b|salário|pretensão salarial|loon|salarisindicatie|wynagrodzeni/, 'salary'],
    [/notice period|earliest .*start|when can you start|available to start|start date/, 'notice'],
    [/preferred (first )?name/, 'preferred_name'],
    [/^(legal )?first name$/, 'first_name'],
    [/^(legal )?(last name|surname|family name)$/, 'last_name'],
    [/^cover letter$/, 'cover_letter'],
    [/^(personal |other )?(website|portfolio|blog)( url| link)?$|^website blog or portfolio$/, 'website'],
    // Anywhere in the label: "I identify my gender as", "What is your ethnicity?".
    [/\bgender\b/, 'gender'],
    [/hispanic|latino/, 'hispanic'],
    [/\b(race|ethnicity|ethnic (origin|background|group))\b/, 'race'],
    [/\bveteran\b/, 'veteran'],
    [/\bdisability\b/, 'disability'],
    // Contact fields by label alone, for forms whose field names mean nothing.
    // Anchored, so a custom question that mentions an email is left alone.
    // Also in French, Spanish, Italian, Portuguese, German, Dutch, Polish
    // and the Nordic languages, as SmartRecruiters and Breezy forms come.
    [/^(legal )?(first|given) name$|^forename$|^(vorname|voornaam|prénom|prenom|nombre|nome|imię|förnamn|fornavn|etunimi)$/, 'first_name'],
    [/^(legal )?(last|family) name$|^surname$|^(nachname|achternaam|apellidos?|nom( de famille)?|cognome|sobrenome|nazwisko|efternamn|efternavn|sukunimi)$/, 'last_name'],
    [/^(your |full |full legal |legal )?name$|^name surname$|^first and last name$|^(volledige naam|vollständiger name|vor und nachname|nom complet|nom et prénom|nombre completo|nombre y apellidos?|nome completo|nome e cognome|imię i nazwisko)$/, 'full_name'],
    [/^(your |votre |confirm (your )?|confirmez (votre )?)?e ?mail( address| adresse| adres)?$|^e ?mailadres$|^(adresse|endereço de|indirizzo) e ?mail$|^(correo|correo electrónico|courriel)$/, 'email'],
    [/^(your )?(mobile |cell |contact )?(phone|telephone|mobile|telefon|telefonnummer|handynummer|telefoonnummer|téléphone|teléfono|telefone|telefono|cellulare|celular|móvil|portable)( number)?$|^(numéro de téléphone|número de teléfono|número de telefone|numero di telefono|numer telefonu)$/, 'phone'],
    [/^(current )?(location|city)( city)?$|^where are you (currently )?(based|located)$|^(ville|ciudad|città|cidade|stadt|wohnort|plaats|woonplaats|localisation|ubicación|miasto)$/, 'location'],
    [/^country( of residence)?$|^(pays|país|paese|land|kraj)$/, 'country'],
    // Hebrew forms (Experis, Comeet and Israeli career sites).
    [/^שם פרטי$/, 'first_name'],
    [/^שם משפחה$/, 'last_name'],
    [/^שם( מלא)?$/, 'full_name'],
    [/^(מייל|אימייל|דוא ?ל|דואר אלקטרוני|כתובת (מייל|אימייל|דוא ?ל))$/, 'email'],
    [/^(נייד|טלפון|טלפון נייד|פלאפון|מספר (טלפון|נייד|פלאפון))$/, 'phone'],
    [/^(עיר|עיר מגורים|מקום מגורים)$/, 'location'],
    [/לינקדאין/, 'linkedin'],
  ];

  // The HTML autocomplete tokens a form may set, whatever its language.
  const BY_AUTOCOMPLETE = {
    'given-name': 'first_name', 'family-name': 'last_name', name: 'full_name', email: 'email', tel: 'phone', 'tel-national': 'phone', 'country-name': 'country',
  };

  // Never sent to an AI provider: the user sets these or they stay blank.
  const EEO = new Set(['gender', 'race', 'hispanic', 'veteran', 'disability']);

  function classify(field) {
    if (BY_NAME[field.name]) return BY_NAME[field.name];
    // Ashby types its phone questions, whatever the label says ("Móvil").
    if (field.type === 'phone') return 'phone';
    if (BY_AUTOCOMPLETE[field.autocomplete]) return BY_AUTOCOMPLETE[field.autocomplete];
    const label = normalise(field.label);
    // Only a file input takes the CV: "Tell us about your resume" is a question.
    if (field.type === 'file') return /cover letter|motivati|lettre/.test(label) ? 'cover_letter' : /resume|résumé|\bcv\b|curr[ií]cul|lebenslauf|קורות חיים|קו ?ח/.test(label) ? 'resume' : null;
    for (const [re, key] of BY_LABEL) if (re.test(label)) return key;
    // An email or phone input labelled in a language the rules above miss.
    if (/refer|recommend|manager|emergency/.test(label)) return null;
    if (field.type === 'email') return 'email';
    if (field.type === 'tel') return 'phone';
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
      case 'full_name': return blank(`${c.first_name || ''} ${c.last_name || ''}`.trim());
      case 'email': return blank(c.email);
      case 'phone': return blank(c.phone);
      case 'location': return blank(c.location);
      case 'phone_country': case 'country': return countryOf(c.location);
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
  function findAnswer(question, answers, jobId) {
    const q = normalise(question);
    if (!q) return undefined;
    // An answer tied to a job ("why do you want to work here?") fills that
    // job only; it names the company it was written for.
    const usable = (answers || []).filter((a) => blank(a.answer) !== undefined && (!a.job_id || a.job_id === jobId));
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

  // Ashby number and date inputs take nothing else, so "30 days" into a
  // number field is a missing answer rather than a failed application. The
  // only file we have is the CV, and that is planned before this.
  function fitsType(field, value) {
    if (field.type === 'file') return false;
    if (field.type === 'number') return /^\s*-?\d+([.,]\d+)?\s*$/.test(value);
    if (field.type === 'date') return !Number.isNaN(Date.parse(value));
    return true;
  }

  // fields: [{name, label, required, type, options}] as an ATS filler reads
  // them. Returns what to type where, and the required ones nobody answered.
  function planFill(fields, profile, job) {
    const fills = [], missing = [];
    for (const f of fields) {
      const key = classify(f);
      if (key === 'resume') { fills.push({ ...f, key, value: 'cv' }); continue; }
      if (key === 'cover_letter') { if (f.required) missing.push({ ...f, key }); continue; }
      // Any other file, or a Workable section (education, experience), is
      // nothing a saved answer can fill in.
      if (f.type === 'file' || f.type === 'group') { if (f.required) missing.push({ ...f, key }); continue; }
      const fits = (v) => v !== undefined && !(f.options && f.options.length && pickOption(f.options, v) < 0) && fitsType(f, v);
      // A profile value the field cannot take ("30 days" against a notice
      // period list or a start date) gives way to a saved answer for this
      // exact question.
      let value = key ? profileValue(key, profile, job) : undefined;
      if (!fits(value)) value = findAnswer(f.label, profile.answers, job && job.id);
      if (!fits(value)) value = undefined;
      if (value === undefined) { if (f.required) missing.push({ ...f, key }); continue; }
      fills.push({ ...f, key, value });
    }
    return { fills, missing };
  }

  // Demographic questions are answered only from what the user set, never
  // by AI. Some have no profile key to map to; their wording marks them.
  function isEeo(field) {
    return EEO.has(field.key || classify(field))
      || /\b(sexual orientation|transgender|lgbt\w*|pronouns?)\b/.test(normalise(field.label));
  }

  // Consent, terms and privacy wording, in English and Hebrew.
  const isStatement = (text) => /privacy|policy|acknowledg|consent|terms|certif|agree|attest|confirm that|מדיניות|פרטיות|מאשר|מסכים|תנאי/i.test(text);

  // A required box agreeing to the site's privacy policy or to processing
  // the application's data: what the "accept required privacy boxes" setting
  // lets a run tick. Never an opt-in to marketing, a talent pool or being
  // kept for other roles, and never a statement about the applicant
  // ("I certify that the information is true").
  const DATA_CONSENT = /privacy|personal (data|information)|data (protection|processing)|process(ing)? (of )?(my|your) (personal |application )?(data|information)|gdpr|consent|מדיניות|פרטיות/i;
  const OPT_IN = /newsletter|marketing|talent (pool|community|network)|future (opportunit|role|position|vacanc|job)|other (role|position|opportunit|job)|keep (me|my|your)|job alerts?|updates|promotional|text messages|sms/i;
  const consentBox = (field) => field.type === 'checkbox' && !(field.options || []).length && !!field.required
    && DATA_CONSENT.test(field.label) && !OPT_IN.test(field.label) && !/certif|attest|true and (correct|complete)|accurate/i.test(field.label);

  // The questions an AI may suggest an answer for, on a form the user
  // checks before it is sent: the required ones nothing answered, and an
  // optional Yes/No radio question nothing is picked in yet. Comeet's
  // screening questions ("Can you work from the Netanya office?") are often
  // optional, and left blank they read as a no. Other optional questions
  // are often follow-ups ("If you picked Trauma above, how many hours"),
  // so they stay blank. Never a file, a demographic question or a checkbox
  // that consents to something: the user ticks those.
  function suggestable(fields, plan) {
    const planned = new Set([...plan.fills, ...plan.missing].map((f) => f.name));
    const starts = (f, words) => (f.options || []).some((o) => words.includes(normalise(o).split(' ')[0]));
    const open = fields.filter((f) => !planned.has(f.name) && f.type === 'radio' && starts(f, ['yes', 'כן']) && starts(f, ['no', 'לא'])
      && !f.checked && !isStatement(f.label));
    return [...plan.missing, ...open].filter((f) => f.type !== 'file' && !isEeo(f)
      && !(f.type === 'checkbox' && (!(f.options || []).length || isStatement([f.label, ...f.options].join(' ')))));
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
    // Submission unconfirmed counts too: it is never retried (contract R5).
    if (mine.some((h) => h.status === 'submitted' || h.status === 'unconfirmed')) return 'already applied';
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

  // Automatic mode: the queued jobs first, then picked candidates that are
  // not queued already, still one per company when the user limits that.
  function withQueued(queued, picked, guardrails) {
    const ids = new Set(queued.map((j) => j.id));
    const companies = new Set(queued.map((j) => j.company_domain));
    const perCompany = (guardrails || {}).one_per_company_days > 0;
    return [...queued, ...picked.filter((j) => !ids.has(j.id) && !(perCompany && companies.has(j.company_domain)))];
  }

  // How many more applications this run may send.
  function budget(usage, history, guardrails, now, perRun) {
    let left = Math.min(usage.remaining, perRun);
    const daily = (guardrails || {}).daily_limit;
    if (daily != null) left = Math.min(left, daily - appliedToday(history, now));
    return Math.max(0, left);
  }

  // The frame holding the application form, from executeScript results
  // over every frame of a tab ({frameId, result: generic formHere()}).
  // The highest score wins; null when no frame has a form.
  function pickFrame(results) {
    let best = null;
    for (const r of results || []) {
      const s = (r && r.result && r.result.score) || 0;
      if (s > 0 && (!best || s > best.result.score)) best = r;
    }
    return best;
  }

  // The word for a count: plural(1, 'field') is 'field', plural(3, 'field') 'fields'.
  const plural = (n, one, many = one + 's') => (n === 1 ? one : many);

  // The fillers and the run compare these reasons and log them, so they
  // stay as they are; the user reads them through reasonText().
  const REASONS = {
    'No application form on this page.': 'No application form found on this page.',
    'A CAPTCHA stands in front of the form. Solve it, then try again.': 'Complete the CAPTCHA, then try again.',
    'application form not found': "Couldn't find the application form.",
    'not on the page': "This field isn't on the page.",
    'job closed': 'This job is no longer accepting applications.',
    'job not found': "Couldn't find this job listing.",
    'page did not load': "The application page didn't load.",
    'submit button not found': "Couldn't find the Submit button. Submit the form yourself.",
    'no options to pick from': 'The list had no options to choose from.',
    'no dropdown on the page': "Couldn't find the dropdown for this question.",
    'no input to type into': "Couldn't find the field for this answer.",
    'no phone box on the page': "Couldn't find the phone number field.",
    'the phone country did not stick': "Couldn't set the phone country. Check it yourself.",
    'no file input': "Couldn't find the file upload field.",
    'needs a date': 'Enter the required date yourself.',
    'sections like this one are not filled': 'Fill in this section yourself.',
    'no CV saved in the extension': 'Add your CV in extension settings, then try again.',
    captcha: 'The site asked for a CAPTCHA.',
    'no confirmation after submitting': "The form was sent, but the site didn't confirm it. Look for a confirmation email.",
    'no confirmation': "The form was sent, but the site didn't confirm it. Look for a confirmation email.",
    'Greenhouse asked for an email security code': 'Greenhouse sent an email security code. Enter it on the page to continue.',
    'unsupported site': "Can't apply automatically on this site. Open the job to fill it in yourself.",
    'blocked company': 'This company is on your Never apply to list.',
    'applied to this company recently': 'You applied to this company recently.',
    'already applied': "You've already applied to this job.",
    'tab closed': 'The tab was closed before the site confirmed the application.',
    'not submitted': 'The tab was closed before the application was sent.',
    'sign in first': 'This site only takes applications from a signed-in account. Open the job to apply yourself.',
    'no Workday password': "Set a Workday password in the extension's options, so runs can sign in to Workday sites.",
    'Workday account to verify': 'Workday emailed you a link to confirm your new account. Click it, then add this job to your queue again.',
    'no email in the profile': 'Add your email under Auto apply settings.',
    'Workday sign-in form not found': "Couldn't find Workday's sign-in form.",
    'Workday account form not found': "Couldn't find Workday's form for a new account.",
    'ready to submit': 'Ready to submit. This site checks that a person sends the form, so open it and press Submit yourself.',
    'unconfirmed: the form closed without a confirmation': "The form was sent, but the site didn't confirm it. Look for a confirmation email.",
  };
  const PREFIXES = [
    ['form errors: ', 'The form needs your attention: '],
    ['Ashby will not take this application: ', "Ashby couldn't submit this application: "],
    ['needs answer: ', 'Needs your answer: '],
    ['Workday sign-in: ', "Couldn't sign in to this company's Workday site: "],
    ['Workday account: ', "Couldn't create an account on this company's Workday site: "],
  ];

  // One reason's own wording, or null when it has none.
  function wording(r) {
    if (REASONS[r]) return REASONS[r];
    for (const [code, text] of PREFIXES) if (r.startsWith(code)) return text + r.slice(code.length);
    const opt = /^no option matches (".*")$/.exec(r);
    return opt ? `None of the options match ${opt[1]}.` : null;
  }

  // An internal reason as the popup, the card and the application history
  // show it. A field's own reason keeps its label ("Country: ..."), and a
  // reason with no wording of its own comes back unchanged.
  function reasonText(reason) {
    const r = String(reason == null ? '' : reason);
    const own = wording(r);
    if (own) return own;
    if (r.startsWith('could not fill ')) return "Couldn't fill in " + r.slice(15).split('; ').map(reasonText).join('; ');
    const field = /^(.+): ([^:]+)$/.exec(r);
    const text = field && wording(field[2]);
    return text ? `${field[1]}: ${text}` : r;
  }

  // What a fill did, for the popup and the card. Counts of zero are left out.
  function filledText(r) {
    const s = [`Filled in ${r.filled} ${plural(r.filled, 'field')}.`];
    if (r.suggested) s.push(`Suggested ${r.suggested} ${plural(r.suggested, 'answer')} with AI (outlined in amber).`);
    const missing = (r.missing || []).length, errors = (r.errors || []).length;
    if (missing) s.push(`${missing} ${plural(missing, 'needs', 'need')} your input.`);
    if (errors) s.push(`${errors} couldn't be filled.`);
    return s.join(' ');
  }

  // Sites that are never a job application, however often a page says
  // "apply": a GitHub folder named apply showed the card, and its Fill
  // button opened the folder.
  const NOT_JOBS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|npmjs\.com|pypi\.org|wikipedia\.org|reddit\.com|youtube\.com|news\.ycombinator\.com|dash\.cloudflare\.com|console\.aws\.amazon\.com|console\.cloud\.google\.com|vendors\.paddle\.com)$/i;
  const notJobSite = (host) => NOT_JOBS.test(String(host || ''));

  // Words that say a page is about a job (detect.js tests the URL, title
  // and heading). Only at the start of a word: "oceanofjobs" in a
  // dashboard's address is a name, not a posting.
  const JOBISH = /\b(?:job|career|apply|application|position|vacanc|opening|recruit|resume|cv\b|hiring|talent|bewerb|stelle|emploi|empleo)|משר|דרוש/i;
  const jobish = (text) => JOBISH.test(String(text || ''));

  const api = {
    notJobSite, jobish, pickFrame, normalise, classify, profileValue, findAnswer, pickOption, planFill, isEeo, isStatement, consentBox, suggestable,
    appliedToday, isBlocked, screenJob, pickJobs, withQueued, budget, countryOf, plural, reasonText, filledText,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.oojMatch = api;
})(globalThis);
