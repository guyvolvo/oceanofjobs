---
name: natural-ui-copy
description: Write customer-facing text that sounds natural, clear and human. Use by default for all user-facing strings (buttons, labels, headings, forms, errors, empty and loading states, success messages, onboarding, tooltips, pricing, upgrade prompts, notifications, emails, dialogs, extension popups, docs, help text, FAQs) whenever creating or modifying UI or features, and when asked to review or polish copy.
---

# Natural UI Copy

## Objective

Write customer-facing text that sounds natural, clear, and human.

The product should sound like it was built by a thoughtful developer who respects the user's time. Never make it sound like an AI assistant, a corporate marketing department, or a startup pitch deck.

This applies to all user-facing text, including:

* Buttons, links, labels, and navigation
* Headings, subtitles, and descriptions
* Forms, placeholders, validation, and error messages
* Empty states, loading states, and success messages
* Onboarding, setup instructions, and tooltips
* Pricing, upgrade prompts, and feature descriptions
* Notifications, emails, and confirmation dialogs
* Extension popups and browser notifications
* Public documentation, help text, and FAQs

## Core principles

### 1. Say what you mean

Use ordinary, specific words. Prefer concrete descriptions of what a feature does over abstract claims about its value.

Bad:
"Unlock a seamless, next-generation job search experience."

Good:
"Search jobs from thousands of company hiring pages."

Bad:
"Empower your workflow with intelligent automation."

Good:
"Fill in job applications using your saved details."

### 2. Remove AI-sounding language

Avoid generic marketing language, inflated claims, and phrases that sound generated rather than written.

Unless there is a specific, justified reason to use them, avoid phrases such as:

* Seamless / seamlessly
* Unlock your potential
* Supercharge your workflow
* Leverage (when "use" works)
* Empower / enable users to
* Revolutionize / transform the way you
* Cutting-edge / next-generation
* Powerful and intuitive
* Effortlessly / with ease
* Elevate your experience
* Take control of
* Your one-stop solution
* Designed to empower
* In today's fast-paced world
* Discover the power of
* All in one place
* Experience the difference
* Get started on your journey
* Whether you're a...
* Say goodbye to... and hello to...
* Built for the future
* At your fingertips

This is not a forbidden-word list. Use a word when it communicates something real. Never use one merely because it sounds polished.

Also avoid repetitive sentence patterns, artificial enthusiasm, vague benefit statements, and strings of adjectives.

### 3. Prefer plain, direct sentences

* Use the shortest wording that communicates the intended meaning.
* Prefer active voice.
* Address the user directly when appropriate.
* Use contractions when they sound natural.
* Prefer familiar words over technical or corporate alternatives.
* Do not explain what the user can already see.
* Do not repeat the heading in the description.
* Avoid unnecessary introductions and filler.
* Do not add exclamation marks to manufacture enthusiasm.

Bad:
"Your application has been successfully submitted and is now being processed by our system."

Good:
"Application submitted."

Bad:
"Please provide your email address in order to continue."

Good:
"Enter your email to continue."

### 4. Write for the specific interface

Copy must fit its context. Do not write every UI element like marketing copy.

#### Buttons

Use short, specific action labels.

Prefer:

* Save changes
* Try again
* View application
* Connect account
* Delete account

Avoid:

* Let's get started!
* Unlock my experience
* Continue your journey
* Submit your information

Use "Continue" or another general label only when the next step is clear from the surrounding context.

#### Headings and descriptions

Tell users what a page or feature does. Do not add a slogan to every page.

#### Forms

Use concise labels and helpful placeholders. A placeholder should not replace a proper label. Explain requirements only when they are not obvious.

#### Errors

Explain what happened and what the user can do next, if known. Be honest about what the system knows.

Bad:
"Oops! Something went wrong. Please try again later."

Better, when accurate:
"Couldn't save your changes. Try again."

If the cause is known, explain it. Never invent an error cause or promise that retrying will fix it.

#### Empty states

Explain why the area is empty when useful and give the user a relevant next step.

Bad:
"Nothing here yet! Your journey starts now."

Good:
"No saved jobs yet. Save a job to find it here."

#### Loading states

Describe the actual operation in progress. Avoid fake progress claims.

#### Success messages

Confirm the result without congratulating users for ordinary actions.

#### Pricing and upgrade prompts

State the actual limit, feature, or difference. Do not use pressure, artificial scarcity, guilt, or exaggerated promises.

#### Destructive actions

Be explicit about what will be deleted or changed. Never sacrifice clarity for brevity when users could lose data.

### 5. Be specific and truthful

Never invent functionality, guarantees, statistics, compatibility, security assurances, or benefits.

* Describe only features that actually exist or are explicitly planned.
* Do not imply an action is automatic if the user must perform it.
* Do not promise an outcome that the product cannot guarantee.
* Do not claim that data is private, secure, encrypted, or never stored without a factual basis.
* Distinguish between what the product does and what the user can choose to do.
* Preserve meaningful limitations, eligibility requirements, usage caps, and pricing conditions.
* If the implementation is unclear, inspect the relevant code before writing copy.

Natural language must not come at the expense of accuracy.

### 6. Match the product's personality

The default voice is:

* Calm, not overly enthusiastic
* Direct, not blunt
* Helpful, not patronizing
* Professional, not corporate
* Friendly, not artificially familiar
* Confident, not boastful
* Concise, not cryptic

Avoid forced jokes, fake empathy, excessive apologies, emoji decoration, and conversational filler.

Do not use "Hey there!", "Awesome!", "Great news!", or "No worries!" by default. Use them only if the specific product genuinely benefits from that personality.

Do not make every product sound like a chatbot. The UI should sound like a well-written interface, not a conversation with an AI.

### 7. Preserve the user's terminology

Use the same terms consistently throughout the product.

* Do not rename existing features without a reason.
* Use the words already established in the UI and product documentation.
* Prefer terminology users understand over internal implementation names.
* Preserve technically important distinctions.
* Do not introduce new concepts or jargon just to make copy sound sophisticated.

When revising existing text, preserve its original meaning, functional requirements, and intended audience.

### 8. Respect context and language

Write for the person using the current screen, not for an imaginary general audience.

Consider what the user is trying to do, what they already know, and what information they need at that moment.

For multilingual interfaces:

* Use natural phrasing in each language, not literal translations.
* Preserve meaning and functionality across translations.
* Respect the product's established terminology.
* Keep labels concise and account for different text lengths.
* Do not assume English sentence structure works in other languages.

## Editing rules

When working in an existing codebase:

1. Find all relevant customer-facing strings before editing.
2. Understand the feature and its behavior before rewriting its copy.
3. Make the smallest changes needed to improve clarity and tone.
4. Preserve variable interpolation, placeholders, localization keys, pluralization, accessibility labels, and dynamic values.
5. Do not change business logic, API contracts, identifiers, or application behavior just to improve wording.
6. Preserve important warnings, consent language, legal disclosures, and security explanations.
7. Follow the project's existing localization and component conventions.
8. Check nearby screens and related states for inconsistent terminology or tone.
9. Run appropriate checks if the changes could affect rendering, localization, or functionality.

Do not rewrite already-good copy just to demonstrate activity. If the existing wording is clear, natural, accurate, and appropriate, leave it alone.

## Final review

Before finishing, review every changed user-facing string and ask:

* Would a real person naturally write this?
* Is it immediately clear what this means?
* Can I remove any words without losing meaning?
* Does it describe the actual product behavior?
* Does it sound like marketing copy when ordinary UI text would be better?
* Is the tone appropriate for the situation?
* Is the wording consistent with the rest of the product?
* Could a nontechnical user understand it?
* Have I preserved all technical, legal, and functional meaning?

Rewrite any string that fails these checks.

## Expected behavior

When asked to implement a feature, apply this writing standard to all new or modified user-facing text by default. Do not wait for the user to ask for a copy review.

When asked to review or polish copy, provide the improved wording directly and explain meaningful changes briefly.

When the user explicitly requests a different voice for a particular surface, follow that instruction for that surface without changing the product's default voice.

The final result should feel unremarkable in the best way: clear, natural, useful, and written by a human who knows what they are trying to say.
