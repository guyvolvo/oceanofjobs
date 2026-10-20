# Ocean of Jobs Chrome extension

Applies to jobs for you, in your own browser. It reads your apply profile from your Ocean of Jobs account, opens a Greenhouse, Ashby or Workable job in a background tab, fills in the form, attaches your CV and sends it. It handles Greenhouse (`boards.greenhouse.io`, `job-boards.greenhouse.io`, and the `embed/job_app` links the API hands out), Ashby (`jobs.ashbyhq.com`) and Workable (`apply.workable.com/j/<shortcode>`, opened at its `/apply/` form page). On any other site, "Fill in this page" in the popup fills the form for you to check and send, and on the job sites our listings come from a small button at the top right of an application form does the same.

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

The popup's "Fill in this page" button fills the application form in the current tab, on any site. Opening the popup grants `activeTab` for the page itself. The page goes to the dedicated filler when one knows the site, otherwise to `ats/generic.js`. If the page is a job posting, the filler follows its Apply link or presses its Apply button first.

A careers page often embeds the form in an iframe from its ATS (comeet.com and company sites embed www.comeet.co, company sites embed Greenhouse). `activeTab` covers only the page, so `fillTab` injects into every frame it may script (`allFrames`) and fills the frame whose form scores highest (`generic.formHere`, `oojMatch.pickFrame`), in one click and without leaving the page. That works when the frame's host is in the host permissions or the user granted every site. Only a frame on a host we cannot reach still sends the tab to the frame's address, where the user clicks once more.

It plans the answers like a run does, asks the AI for the questions your saved answers don't cover (outlined in amber), and outlines the required ones still empty in red. Consent and terms checkboxes are never ticked for you, and EEO questions never go to an AI. Nothing is submitted and no credit is claimed: you check the form and send it yourself. A run never uses the generic filler.

## The fill button

`detect.js` runs in every frame of the ATS sites in the manifest. It looks for an application form in the page (at least three fields with an email, phone, file or text area, not a search, login, newsletter or comment form) and, when the form asks for a CV or the page's address or title says it is about a job, shows a small round button with the lighthouse at the top right. It moves down past the site's own links and buttons there. Nothing is sent anywhere until the button is clicked; pages without a form get nothing. A form inside an iframe asks the page around it to show the button, so the user sees it where they would expect.

Clicking the button opens a card. On a form a dedicated filler knows (Greenhouse, Ashby, Workable) it is the same card as before: fill, check, then "Submit application" from the card, which claims a credit, and only when the account has "Jobs I view anywhere on the web" turned on. On any other form the card only fills; the user presses the site's own submit and no credit is claimed. "Hide on this site" hides the button on that host until Chrome restarts (`chrome.storage.session`).

## Permissions

- `storage`, `alarms`: the connection, CV, settings and the 15 minute run.
- `scripting`, `activeTab`: fill the tab the popup was opened on. No `tabs` permission.
- Host permissions: oceanofjobs.com for the API, and the job and application sites our listings come from, one pattern per ATS where it has its own domain: Greenhouse, Ashby, Workable, Lever, SmartRecruiters, Recruitee, Personio, Teamtailor, Breezy, Comeet, Workday, Oracle Recruiting Cloud, Deel, JazzHR (applytojob.com), Pinpoint, BambooHR, Jobvite, HiBob, Gem, Eightfold, Niloosoft (hunterhrms.com), the big tech careers sites (Amazon, Microsoft, Apple, Check Point, Ness) and the Israeli boards we read (Experis, Matrix, Nogamy, Yael Group, Clalit's RedMatch board, IAI). google.com is left out: Chrome ignores the path in a host permission, so `/about/careers/` would mean all of Google. Sources whose jobs live only on company domains (WordPress boards, Recruitee and Personio custom domains) are covered by the optional access below.
- Optional `https://*/*`: every https site. The popup asks for it the first time "Fill in this page" is clicked on a site outside the host permissions, with a line saying why. It asks once (`allSitesAsked`, saved before the answer since the prompt can close the popup), so a no is never asked again from the popup; Settings has a toggle that asks or removes it. When granted, `background.js` registers `ats/generic.js` and `detect.js` for every https page except oceanofjobs.com and the ATS sites (`detect-all`, all frames, `document_idle`, kept across restarts), and drops them again when the access is removed (`chrome.permissions.onAdded` and `onRemoved`).
- Optional `api.anthropic.com`, `api.openai.com`: asked when the user saves their own AI key.

Adding hosts to `host_permissions` makes Chrome disable the extension for existing users on update until they accept the new sites. The optional access never does.

### For the Chrome Web Store privacy tab

Host permission justification:

> The extension fills in job applications from the user's Ocean of Jobs profile. It needs oceanofjobs.com to read that profile, and the listed job and application sites (Greenhouse, Lever, Ashby, Workable, Comeet, Teamtailor, Workday and the other applicant tracking systems the Ocean of Jobs job board lists) to find the application form on a page, show a fill button next to it, and fill it when the user clicks. On Greenhouse, Ashby and Workable it can also submit applications the user has queued. It reads nothing on these sites beyond the application form, and sends the user's details only to the form the user is applying through.

Optional host permission (all https sites) justification:

> Requested only when the user asks for it, from a click on "Fill in this page" or a toggle in the settings. Many companies embed their application form from an applicant tracking system in an iframe, or run their careers page on their own domain. With this access the extension can fill those embedded forms in one click and show its fill button on any careers page. Each page is checked locally for an application form; on pages without one the extension does nothing, and nothing about the pages the user visits is sent anywhere. The user can remove the access in the extension's settings or at chrome://extensions.

## Files

- `manifest.json`, `background.js` (alarm, API calls, run loop)
- `connect.js` (token handoff on oceanofjobs.com)
- `detect.js` (the fill button and its card)
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

There is no DOM library in this repo, so the tests cover the pure parts and run the saved Greenhouse pages, Ashby form definitions and Workable form specs through the readers and the planner. `tests/e2e/_ext_background_run.mjs`, `_ext_ashby_run.mjs` and `_ext_workable_run.mjs` load the extension in Chromium and run it against live forms with every write blocked. The generic filler is tested in a browser too: `_ext_generic_fixtures.mjs` on small forms built in the test, and `_ext_generic_fill.mjs` on live forms across a dozen ATSes. `_ext_detect.mjs <out-dir>` opens the fill button and card on a live Greenhouse form, and `_ext_embedded_fill.mjs [out-dir]` covers forms in iframes (Comeet on comeet.com and on a company careers page), the fill button on ATS pages and its absence elsewhere, and the permission model with and without every-site access.

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
