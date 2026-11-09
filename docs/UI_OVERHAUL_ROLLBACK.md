# UI overhaul: the switch and how to undo it

Nothing here has been deployed. This is how the first migrated pages
(privacy, terms, refunds, contact, 404) would go live, and how to take
them back. Later pages follow the same pattern.

## What the switch changes

Only the deploy. The CloudFront function, its behaviours and the bucket
layout stay as they are.

1. **`.github/workflows/deploy-frontend.yml`**, step "Put the contact page
   with the static pages". Today it copies one file:

   ```sh
   cp apply/dist/contact.html frontend/contact.html
   ```

   The switch copies every migrated page over its static twin in the
   runner's checkout (the repo's `frontend/*.html` are never changed in
   git):

   ```sh
   for p in privacy terms refunds contact 404; do cp "apply/dist/$p.html" "frontend/$p.html"; done
   ```

   The home page goes to the bucket's index, not to `frontend/home.html`:

   ```sh
   cp apply/dist/home.html frontend/index.html
   ```

   and `frontend/index.html` joins the `sed` list in step 2. Its rollback
   is the same revert; the repo's own `frontend/index.html` comes back.

2. Same file, step "Stamp asset URLs with the commit". Its second `sed`
   removes the `?v=` stamp from `/apply/assets/...` (Vite's loader needs the
   exact href) and today names `frontend/contact.html` only. It has to name
   every copied page:

   ```sh
   sed -i -E "s#(/apply/assets/[^\"?]+)\?v=$v#\1#g" apply/dist/index.html apply/dist/account.html \
     frontend/privacy.html frontend/terms.html frontend/refunds.html frontend/contact.html frontend/404.html
   ```

3. Nothing else. On the next deploy:
   - S3 keys `privacy.html`, `terms.html`, `refunds.html`, `contact.html`
     and `404.html` at the bucket root are overwritten by the new HTML
     (the `aws s3 sync frontend/` step).
   - Their scripts and styles land under the `apply/` prefix
     (`apply/assets/*`, the "Sync the auto apply dashboard" step).
   - `404.html` still gets its `otj-status=404` metadata from the step
     after the sync, so `not_found_status` keeps answering 404.
   - The CloudFront function needs no change: `/privacy`, `/terms`,
     `/refunds` and `/contact` are already in `PAGES`, and every unknown
     address already goes to `/404.html`.
   - The deploy's `/*` invalidation makes the switch visible at once.

`npm run build` now also prerenders (tokens, tsc, client build, SSR build,
`scripts/prerender.mjs`), so a page that fails to render stops the deploy
before anything is uploaded, as a failed build does today.

### Separate change: `/account/*`

Not needed for these pages, but the new workspace links to
`/account/alerts`, `/account/settings` and so on, which return 404 in
production today. `infra/cloudfront.tf` (`legacy_domain_redirect`) needs a
prefix rule like the one `/apply/*` has:

```js
if (uri === "/account" || (uri.indexOf("/account/") === 0 && last.indexOf(".") === -1)) {
  request.uri = "/apply/account.html";
  return request;
}
```

This is a Terraform apply. To undo it, restore the bare `/account` rule
and apply again. The local preview has this rule on by default; run it
with `--prod-account` to see today's behaviour.

## Rolling back

The old pages are still in git at `frontend/<page>.html`, and the bucket
is not versioned (`infra/s3.tf` versions only the data bucket), so git is
the source of the rollback.

### Normal: revert and redeploy (about 5 minutes)

1. `git revert` the commit that changed `deploy-frontend.yml` and push to
   `main`. The workflow runs on the change.
2. The sync uploads the repo's own `frontend/privacy.html`, `terms.html`,
   `refunds.html`, `contact.html` and `404.html` over the new ones, the
   `404.html` metadata step runs as before, and the `/*` invalidation
   clears the edge.
3. Check: `curl -sI https://oceanofjobs.com/privacy` is 200,
   `curl -sI https://oceanofjobs.com/no-such-page` is 404, and the HTML
   links `/style.css` again.

Leave the files under `apply/assets/` alone. The next deploy's
`--delete` sync of `apply/` tidies them, and nothing links to them after
the rollback.

Note: before the switch, `/contact` was already served from this build
(the Kumo version). Rolling back to the static `frontend/contact.html` is
not possible because there is none; the revert brings back the copy of
`apply/dist/contact.html`, which on the reverted commit is the Kumo page.

### Emergency: without CI (about 2 minutes)

With the deploy role's credentials (AWS profile `openmarket-tf`, region
`il-central-1`), from a checkout of the last good commit:

```sh
for p in privacy terms refunds; do
  aws s3 cp "frontend/$p.html" "s3://$FRONTEND_BUCKET/$p.html" \
    --content-type "text/html; charset=utf-8" --cache-control no-cache
done
aws s3 cp frontend/404.html "s3://$FRONTEND_BUCKET/404.html" \
  --metadata otj-status=404 --content-type "text/html; charset=utf-8" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths /privacy /terms /refunds /contact /404.html "/*"
```

For `/contact`, build the last good commit's `apply/` and copy its
`dist/contact.html` the same way. These pages carry no `?v=` stamp when
copied by hand; that only matters for Cloudflare's four-hour cache of
`style.css`, which the old pages already share with every other page.

## What to watch after a switch

- `npm run check:html` against live (canonical, title, description,
  words, links, `<main>` text).
- The 404 status: `curl -s -o /dev/null -w "%{http_code}" https://oceanofjobs.com/jobs/x`
  must be 404.
- The cookie banner, the "Log in" window and the theme switch on one page
  in each theme.
