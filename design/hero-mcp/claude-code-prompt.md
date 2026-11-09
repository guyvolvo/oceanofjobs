# Replace the homepage hero with the MCP terminal hero

Repo: guyvolvo/opentechjobs. The frontend is framework-less, in `frontend/`: `index.html`, `style.css`, `app.js`. There's no build step, and everything is self-hosted. Read `README.md` and `DESIGN.md` first. Nothing outside `frontend/` changes.

I'll add the reference files to `design/hero-mcp/` before you start:

- `hero-prototype.html`: the finished hero as a working page (header, hero, ticker placement). This is the source of truth for markup, CSS values and the animation script. Its asset URLs already point at the repo's paths.
- `hero-spec.md`: every value written down, plus the animation timeline. If the prototype and the spec disagree, the spec wins; tell me where.
- `screenshots/`: the final state at 1440 (1x and 2x) and 390. The 390 shot hides the nav because the prototype's header isn't responsive. Keep the site's existing mobile header.
- `img/dither-mcp.png`: copy it to `frontend/img/dither-mcp.png`.
- `fonts/GeistMono-Regular.woff2`, `GeistMono-Medium.woff2`, `GeistMono-Bold.woff2`, plus `LICENSE.txt` (OFL): copy these to `frontend/fonts/`.

## What changes

1. **Hero section** (`section.home-hero` in `index.html`): replace its contents with the prototype's hero.
   - Left: the h1, the new description, a search form, and an "API docs" link.
   - Right: the terminal window on the dither panel, with the install strip below it.
   - Copy, exactly as written:
     - h1: `find your next opportunity` (lowercase)
     - description: `Ocean of Jobs is a free, minimalist job search platform built by developers, for developers. Connect your AI agent using the MCP server to start automating your job search.`
     - search placeholder: `Find your perfect job`
     - link: `API docs` → `/api/help`
     - terminal text: take it verbatim from the prototype.
2. **Search form**: `<form action="/board" role="search">` with a single input, `name="search"`. The board reads `?search=` (`app.js`, where `state.search` is set). `?q=` is only kept there for old links, so don't use it.
   - The input has `aria-label="Search jobs"`.
   - The submit button is a real `<button type="submit" aria-label="Search">`.
   - An empty submit goes to `/board` with no parameter.
   - The input has no outline of its own. Put a visible focus ring on the form with `:focus-within`.
3. **Remove the lighthouse hero visual**: the `.home-flower` block with the `lh-*` SVG and beams, its CSS and any JS that drives it. Delete `img/home-lighthouse.svg` only if nothing else references it. Don't touch `img/email-lighthouse.png`; the emails use it.
4. **Header alignment**: restyle, don't rewrite.
   - Put the header row in the same container as the hero (1180px, 40px padding), so the logo mark lines up with the h1.
   - Make the row a three-column grid (`1fr auto 1fr`) so the nav is centred on the page.
   - Give the items `line-height: 1` and make the avatar 28px.
   - Keep `#hero-bar-right`, `#hero-account`, `#hero-theme` and their JS exactly as they behave now.
5. **Fonts**: point the site's Geist Mono `@font-face` rules at the three new full files (400, 500, 700).
   - The `-latin` Geist Mono subsets lack `●` and the bold weight, and the terminal needs both.
   - Remove the old `GeistMono-*-latin.woff2` files only if nothing else references them.
   - Geist sans stays as it is.
   - `⎿ ✻ ⏵ ❯` aren't in Geist Mono at all. They fall back to the system monospace, which is fine. Don't add a font for them.
6. **Ticker**: keep the existing component unchanged:
   - `section.hero-band`
   - `#ticker-logos-a` and `#ticker-logos-b`
   - their CSS
   - the `/api/stats` and `/img/wordmarks/` loader

   It goes directly under the hero, as in the screenshots. The prototype's ticker is invented placeholder logos; don't build them.

## Behaviour

- **Animation:** the terminal plays once, the first time it's on screen, then rests with only the caret blinking. The timeline and pause/resume logic are in the spec and the prototype script.
- **Reduced motion:** under `prefers-reduced-motion: reduce` it shows the finished state immediately.
- **Copy buttons:** the install strip's copy buttons use `navigator.clipboard`. If the site already has a copy helper (the API section's `#api-copy`), reuse it.
- **Themes:** the terminal window and dither panel stay dark in both themes. Everything else, including the install strip rows, follows the existing theme tokens. Check the light theme looks deliberate, not inverted by accident.
- **Background colour:** use the site's existing page background for the hero. The design's `#050505` is close enough that you shouldn't add a new token for it.

## Things I haven't confirmed. Check them and tell me.

- **MCP server:** the MCP server isn't in this repo as of the snapshot I designed against. The endpoint `https://oceanofjobs.com/mcp`, the `claude mcp add` line, and the tool call shown in the terminal (`search_jobs` with `query`, `city`, `seniority`, `max_age_days`) are placeholders.
  - If the server exists by the time you run this, use its real path, tool name and argument names, and change the terminal text and install strip to match.
  - If it doesn't exist yet, keep the strings, and list them in your summary as unverified.
  - Either way, don't link the install strip anywhere.
- **Job rows:** the three rows are copied from a real MCP session and stay as static text. Don't turn the job URLs into links; they will expire.

## Rules

- **Accessibility:** keep the semantics accessible:
  - one `<form role="search">`, real buttons and links, visible focus rings;
  - the terminal marked `aria-hidden="true"`, since it's a demo, not content;
  - the dither decorative.

  Lighthouse accessibility should not drop.
- **Fit and responsiveness:** check 1440, 1024, 768 and 390.
  - At 1440, header plus hero must fit in 900px.
  - At 390, nothing scrolls sideways and the order is text, terminal, install strip, ticker.
  - At 1024 the two columns may get tight. If the text column drops under about 420px, switch to one column there rather than squeezing it, and tell me the breakpoint you picked.
- **No new dependencies:** no build step, no external requests.
- **Copy and links:** don't invent copy, numbers or links. If something can't be built as specified, do the closest honest thing and list it.
- **Commit:** make one commit, with a message saying what was replaced, what was added and what was deleted. Don't push.

When you're done, give me:

- the files you changed;
- screenshots or a description at 1440 and 390, in both themes;
- the MCP strings you verified or couldn't;
- anything you deviated from, and why.
