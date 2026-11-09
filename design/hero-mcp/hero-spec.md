# Homepage hero: build spec

`hero-prototype.html` is the working reference. It's plain HTML, CSS and one script, and its markup, CSS and JS can be lifted almost as is. Its asset URLs already point at the repo's paths: `/fonts/...`, `/img/dither-mcp.png` and `/favicon.svg`. The screenshots show its final state at 1440 and 390.

## Tokens

| name | value |
|---|---|
| ground | `#050505` in the design; use the site's existing dark page background, don't add a second near-black |
| text | `#f4f1ee` |
| description | `#a1a1aa` (7.9:1 on the ground) |
| secondary | `#9a9ca3` |
| hairline | `rgba(255,255,255,0.08)` |
| card (install strip rows) | `#0a0a0b` |
| terminal frame | `#1c1c1e`; title bar gradient `#2c2c2e` to `#262628` |
| terminal body | `#0d0d0e` |
| terminal text | base `#e4e4e4`, bright `#f2f2f2`, bold `#f6f6f6` at 700, dim `#8b8b8b`, green `#2fae60`, lavender `#a8a9f2` (ages), amber `#e7b416` (spinner, auto mode) |
| traffic lights | `#ff5f57`, `#febc2e`, `#28c840`; 12px, 8px apart |

## Type

Two families only: Geist and Geist Mono.

| element | font | size / weight |
|---|---|---|
| h1 | Geist | 60px / 500, line-height 61px, tracking -0.04em (44px / 45px under 900px) |
| description | Geist | 17px / 400, line-height 26px, max-width 480px |
| search input | Geist | 16px (15px on phones) |
| API docs | Geist | 15px |
| terminal | Geist Mono | 12px, line-height 16px (11px / 15px on phones); ligatures, kerning and synthetic bold off |
| install strip | Geist Mono | 12px |

Line-heights are in px, not ratios, on purpose. That keeps every line box on a whole pixel so the terminal text stays sharp. Keep it that way.

## Layout

Desktop:

- The header and hero share one container: 1180px max, 40px side padding. The logo mark starts on the h1's left edge.
- The hero grid is `1fr 540px` with a 56px gap, `align-items: start`, and padding 104px top / 56px bottom.
- The text column has `min-height: 482px` (the terminal window's height) and centres its contents vertically, so the text sits on the window's centre line.
- Header plus hero is 888px, under a 900px fold.

Under 900px:

- One column with a 56px gap, 16px gutters, padding 56px / 48px.
- The order is: text, terminal, install strip, then the ticker.
- The text column drops its min-height.
- Nothing scrolls sideways at 390.

## Header

This is a restyle of the existing header, not a rebuild.

- The inner row is `display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 64px`.
- Brand: `justify-self: start`. Nav: centre column, so it's centred on the page. Account / theme: `justify-self: end`.
- Header items get `line-height: 1`.
- The avatar is 28px with a 13px / 500 initial.

## Text column

1. The h1 "find your next opportunity", lowercase as written.
2. The description, 22px below it: "Ocean of Jobs is a free, minimalist job search platform built by developers, for developers. Connect your AI agent using the MCP server to start automating your job search."
3. The search form, 34px below the description:
   - **Form:** `<form action="/board" role="search">`, max-width 400px, height 60px, `border-radius: 999px`, background `rgba(244,241,238,.95)`, padding `0 6px 0 24px`.
   - **Input:** `name="search"`, `type="search"`, `aria-label="Search jobs"`, placeholder "Find your perfect job". Text in the ground colour, placeholder `#7a7c82`, no border, no outline (the focus ring goes on the form; see the prompt).
   - **Submit:** 84 × 48 dark pill with the 19px arrow icon, `aria-label="Search"`.
   - **Phones:** height 54px, left padding 18px, button 60 × 42.
4. "API docs" link, 18px below the form: links to `/api/help`, 40px tall, padding `0 16px`, pill, background `rgba(255,255,255,.07)`, with a 14px ↗ icon in the secondary colour.

## Terminal window

- **Frame:** 540px wide, 10px radius. Shadow: `0 0 0 1px rgba(0,0,0,.85), inset 0 0 0 1px rgba(255,255,255,.10), 0 24px 48px -12px rgba(0,0,0,.65), 0 60px 120px -30px rgba(0,0,0,.6)`.
- **Title bar:** 30px tall, traffic lights only. No title text.
- **Body:** 452px tall (520px on phones), padding `12px 14px 10px`. It's a flex column: the session sits at the top and the input area at the bottom.
- **Session:** top to bottom, 10px apart: user line, tool line, `⎿ 3 matches`, answer header, three numbered job rows, then the Churned line. The exact strings and classes are in the prototype; use them verbatim.
- **Input area:** a 1px `#5a5a5a` rule running the full body width, the `❯` prompt with a 1 × 14px blinking caret, then `⏵⏵ auto mode on` in amber and `(shift+tab to cycle)` dim.

## Dither panel

The panel sits behind the window as `::before` on the window's wrapper. The wrapper gets `isolation: isolate`; the pseudo-element gets `z-index: -1`.

- Inset −48px on every side, `border-radius: 16px`, `opacity: .9`.
- `background: url(/img/dither-mcp.png) center 40% / 1152px 768px`, with `image-rendering: pixelated`.
- The PNG is 384 × 256, one pixel per dither dot, two colours. The display size is exactly 3×, so every dot is a crisp 3px square. Keep the size a whole multiple of 384 × 256.
- Under 900px: inset −16px, radius 12px.

The window and the dither panel are an image of a product, so they stay dark in both site themes.

## Install strip

- 64px below the window (32px on phones), the same width as the window.
- Two rows, 6px apart. Each row: min-height 36px, padding `4px 10px 4px 12px`, hairline border, 8px radius, card background, Geist Mono 12px.
- Each row has a 28px copy button (13px icon) that writes the row's text with `navigator.clipboard`.
  - Row 1: `https://oceanofjobs.com/mcp`
  - Row 2: `claude mcp add --transport http oceanofjobs https://oceanofjobs.com/mcp`, with `claude mcp add` in the secondary colour.

The strip follows the site theme.

## Animation (plays once)

| at | what |
|---|---|
| 0 to 2000ms | the prompt types into the `❯` line (`length × t / 2000`) |
| 2000 | input clears; user line, tool line and `✻ Churning… (esc to interrupt)` appear, spinner glyph cycling every 120ms |
| 3000 | `⎿ 3 matches` and the answer header enter |
| 3120, 3240, 3360 | rows 01, 02, 03 enter |
| 3480 | spinner becomes `✻ Churned for 3s · done 1:30 PM`; the timeline stops for good |
| after | only the caret blinks (1s, `steps(1)`) |

How it runs:

- Each entrance is opacity 0→1 plus translateY 6px→0, 220ms ease-out.
- One `requestAnimationFrame` timeline. It starts paused and begins the first time the window is at least 10% visible (`IntersectionObserver`) while the tab is visible.
- It pauses if the visitor scrolls away or switches tabs mid-play, and resumes where it left off. Once finished it never restarts.
- Under `prefers-reduced-motion: reduce` it renders the finished state immediately.

## Ticker

The design's ticker uses invented placeholder logos. They only show the placement: two rows directly below the hero, fading at both edges, with 24px above and 96px below. Keep the site's existing ticker component; don't build the placeholders.
