# Ocean of Jobs Chrome extension

Applies to jobs for you, in your own browser. It reads your apply profile from your Ocean of Jobs account, opens a Greenhouse, Ashby or Workable job in a background tab, fills in the form, attaches your CV and sends it. It handles Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`, and the `embed/job_app` links the API hands out), Ashby (`jobs.ashbyhq.com`) and Workable (`apply.workable.com/j/<shortcode>`, opened at its `/apply/` form page). On any other site, "Fill in this page" in the popup fills the form for you to check and send. The card on the page itself is Greenhouse only for now.

Plain JavaScript, Manifest V3, no build step and no dependencies.

## Load it

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and pick this `extension/` folder.
3. Open the extension's settings and add your CV (PDF or DOCX, up to 5 MB).
4. On https://oceanofjobs.com/account#autoapply, connect the extension.

## Connecting without copy and paste

`connect.js` runs on `https://oceanofjobs.com/*`. It sets `document.documentElement.dataset.oojExtension = "1"` so the site can tell the extension is installed. The account page creates a personal access token (scope "extension") and posts `{type: "ooj:connect", token}` to the window. The content script accepts it only from the page itself, from the `https://oceanofjobs.com` origin, and only if the token starts with `ooj_`. It stores the token in `chrome.storage.local` and answers `{type: "ooj:connected"}`. `{type: "ooj:disconnect"}` deletes the token. A 401 from the API marks the connection as revoked and the popup offers "Reconnect".

## What a run does

An alarm fires every 15 minutes unless you paused it in the popup. A run reads `/me/apply/profile`, `/me/apply/usage` and `/me/apply/history`, then works out how many it may send: at most 3 per run, never more than the plan has left, and never past your own daily limit.

- Queue mode takes jobs from `/me/apply/queue`. Jobs that are closed, gone, on another ATS or ruled out by your guardrails are reported as skipped and removed from the queue.
- Auto mode asks the public `/jobs` for Greenhouse, Ashby and Workable jobs from the last 14 days that match your search preferences (`skills`, `seniority`, `workplace`, `country`, `city`), newest first, then drops blocked companies, companies you applied to within `one_per_company_days`, jobs already in your history and jobs below `min_match`.

For each job, one at a time:

1. Open the job in a background tab and read the form. Greenhouse ships the questions, with every select's options, as JSON in `window.__remixContext`. That is read from the page's own world, since a content script can't see page globals. Ashby's tab opens on the posting's `/application` route, and the form comes from the same read-only GraphQL query (`ApiJobPosting`) the page itself makes. Workable's form page renders from a JSON spec it fetches (`/api/v1/jobs/<shortcode>/form`); the filler waits for the form to render and fetches the same spec.
2. Plan the answers (`lib/match.js`). Known fields come from the profile. Other questions are matched against your saved answers by normalised text. EEO questions are only answered when you set a value, and "decline" picks the "I don't wish to answer" option.
3. A required question with no answer, when your settings say to use AI, is drafted by `/me/apply/draft` on Basic and Pro, or with your own Anthropic or OpenAI key on Free (or once the plan's AI answers run out). If nothing answers it, the job is reported `skipped` with `needs answer: <question>` and the question shows up in the popup.
4. Claim the job with `/me/apply/claim`. A 402 ends the run and a 409 moves on. Nothing is sent without a claim.
5. Fill, attach the CV, press submit, then wait up to 45 seconds for the confirmation (Greenhouse's `.../confirmation` page, Ashby's success message, Workable's thank-you panel). The result goes to `/me/apply/result`: `submitted`, or `failed` with a short reason (form errors, CAPTCHA, an emailed security code, Workable's "Something went wrong", no confirmation). A CAPTCHA ends the run.

The tab is closed afterwards. The badge shows how many applications went out today.

## Fill in this page

The popup's "Fill in this page" button fills the application form in the current tab, on any site. Opening the popup grants `activeTab`, which is the only access it needs; the extension has no host permission for other sites. The page goes to the dedicated filler when one knows the site (Greenhouse today), otherwise to `ats/generic.js`. If the page is a job posting, the filler follows its Apply link or presses its Apply button first. A careers page that embeds the form from another site is sent to that site; `activeTab` does not follow, so the user clicks the button once more there.

It plans the answers like a run does, asks the AI for the questions your saved answers don't cover (outlined in amber), and outlines the required ones still empty in red. Consent and terms checkboxes are never ticked for you, and EEO questions never go to an AI. Nothing is submitted and no credit is claimed: you check the form and send it yourself. A run never uses the generic filler, and the card on Greenhouse forms is unchanged.

## Files

- `manifest.json`, `background.js` (alarm, API calls, run loop)
- `connect.js` (token handoff on oceanofjobs.com)
- `ats/greenhouse.js`, `ats/ashby.js` and `ats/workable.js` (the fillers that also send). Another ATS goes in its own file with the same functions: `matches`, `onSite`, `pageData`, `read`, `fill`, `submit`, `outcome`, plus `formUrl` when the form lives at another address than the job, and gets an entry in `ATS_FILES` in `background.js`.
- `ats/generic.js` (the fallback filler for any other page: finds the form, reads labels from the DOM, fills text, selects, radios, checkboxes, comboboxes and file inputs; it never sends)
- `lib/match.js` (pure functions: normalising labels, classifying fields, saved answer lookup, option picking, guardrails)
- `popup.*`, `options.*`, `ui.css`
- `test/` (node:test, with Greenhouse pages, Ashby form definitions and Workable form specs saved under `test/fixtures/`)

## Privacy

Your CV and AI key are kept in `chrome.storage.local`. The CV is only sent to the employer you apply to. Your own key is only sent to the provider you picked. Access to that provider's host is requested when you save the key, not at install.

## Tests

```
node --test extension/test/
```

There is no DOM library in this repo, so the tests cover the pure parts and run the saved Greenhouse pages, Ashby form definitions and Workable form specs through the readers and the planner. `tests/e2e/_ext_background_run.mjs`, `_ext_ashby_run.mjs` and `_ext_workable_run.mjs` load the extension in Chromium and run it against live forms with every write blocked. The generic filler is tested in a browser too: `_ext_generic_fixtures.mjs` on small forms built in the test, and `_ext_generic_fill.mjs` on live forms across a dozen ATSes.

## Not supported yet

- Applying on its own anywhere but Greenhouse, Ashby and Workable. Other jobs in a run are reported as `skipped` with "unsupported site"; "Fill in this page" covers them by hand.
- Ashby file questions other than the CV, and Ashby's optional survey forms (demographic questions, never required in a survey of 30 boards).
- With "Fill in this page": forms behind a sign-in or a CAPTCHA, multi-step wizards past their first step, and upload menus that keep the file input outside the form (Jobvite).
- Greenhouse jobs whose link points at the company's own careers site rather than greenhouse.io.
- Cover letters. A job that requires one is skipped.
- Education and experience sections, if a board makes them required. Optional ones are left empty.
- Files other than the CV (a portfolio, certificates). A job that requires one is skipped.
- Answering the work authorization question from the job's country: `/api/jobs` doesn't return the job's country yet, so that question falls back to your saved answers.

## Updating

The manifest carries a fixed `key`, so the extension keeps the same id (epmalmdedhbbgcpghhpobghpneddabic) whatever folder it is loaded from. To update, load the new folder with Load unpacked without removing the old one first: the new copy replaces it and keeps the connection, CV and AI key. Removing the extension deletes them. Remove `key` from the manifest before uploading to the Chrome Web Store, which assigns its own.
