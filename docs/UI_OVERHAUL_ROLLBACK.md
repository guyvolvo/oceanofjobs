# UI overhaul: what ships and how to undo it

## What goes live when this branch is merged

`deploy-frontend.yml` runs on any push to `main` that touches `apply/`. It
builds `apply/` and uploads all of `apply/dist/` to the bucket's `apply/`
prefix on every deploy, so merging ships these pages at once:

- `/apply` and `/account`: the new workspace (`apply/index.html`,
  `apply/account.html`, `src/workspace`). It replaces the Kumo dashboard and
  account page that `main` serves today.
- `/contact`: the new contact page. The step "Put the migrated pages with
  the static pages" copies every page named in `apply/migrated.json`
  (today only `contact`) over its static twin, `frontend/contact.html`.
  There is no static contact page in git; the Kumo one it replaces was
  `apply/src/Contact.tsx`, which this branch deletes.

Every other page (home, board, companies, stats, pricing, checkout, the
legal pages, 404) is still served from `frontend/`. Their React versions
are built and prerendered but not uploaded over the static ones. Preview
them with `node apply/scripts/preview.mjs --all`.

## Before the merge: the `/account/*` rule

The workspace routes `/account/alerts`, `/account/settings`,
`/account/billing` and the other sections on the client. Production
answers those addresses with the 404 page until the CloudFront function
has the prefix rule this branch adds to `infra/cloudfront.tf`
(`legacy_domain_redirect`):

```js
if (uri === "/account" || (uri.indexOf("/account/") === 0 && last.indexOf(".") === -1)) {
  request.uri = "/apply/account.html";
  return request;
}
```

Run the Terraform apply for it BEFORE the merge triggers the frontend
deploy. The rule is safe for the old account page too (it reads its
section from the hash), so it can stay in place through a frontend
rollback. To undo it, restore the bare `/account` rule and apply again.
The local preview has the rule on; `--prod-account` shows the old
behaviour.

## Switching another page later

Add its name to `apply/migrated.json` (`home` goes to the bucket's
`index.html`). The deploy and `apply/scripts/preview.mjs` read the same
list. `/privacy`, `/terms`, `/refunds`, `/pricing`, `/checkout`, `/stats`,
`/companies` and `/board` are already in the CloudFront function's
`PAGES`, and every unknown address already goes to `/404.html`. `404.html`
keeps its `otj-status=404` metadata from the step after the sync. Removing
a name from the list and pushing brings that page's static twin back.

## Rolling back

The bucket is not versioned (`infra/s3.tf` versions only the data bucket),
so git is the source of the rollback.

### Normal: revert and redeploy (about 5 minutes)

1. `git revert -m 1 <merge commit>` on `main` and push. The workflow runs
   on the change, rebuilds the previous `apply/` (the Kumo dashboard,
   account page and contact page) and syncs it over `apply/` with
   `--delete`.
2. The frontend sync uploads `frontend/` from the reverted tree, the
   `404.html` metadata step runs as before, and the `/*` invalidation
   clears the edge.
3. Check: `curl -sI https://oceanofjobs.com/contact` and `/account` are
   200, `curl -sI https://oceanofjobs.com/no-such-page` is 404.

To roll back one switched page only, remove it from `apply/migrated.json`
and push, as above.

### Emergency: without CI (about 5 minutes)

With the deploy role's credentials (AWS profile `openmarket-tf`, region
`il-central-1`), from a checkout of the last good commit:

```sh
cd apply && npm ci && npm run build && cd ..
aws s3 sync apply/dist/ "s3://$FRONTEND_BUCKET/apply/" --delete --cache-control no-cache
aws s3 cp apply/dist/contact.html "s3://$FRONTEND_BUCKET/contact.html" \
  --content-type "text/html; charset=utf-8" --cache-control no-cache
for p in index privacy terms refunds pricing checkout companies stats board; do
  aws s3 cp "frontend/$p.html" "s3://$FRONTEND_BUCKET/$p.html" \
    --content-type "text/html; charset=utf-8" --cache-control no-cache
done
aws s3 cp frontend/404.html "s3://$FRONTEND_BUCKET/404.html" \
  --metadata otj-status=404 --content-type "text/html; charset=utf-8" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"
```

The loop puts back the static pages a later switch may have replaced,
the home page (`index.html`) included. Copying a page that was never
switched changes nothing. Pages copied by hand carry no `?v=` stamp; that
only matters for Cloudflare's four-hour cache of `style.css`, which the
old pages already share with every other page.

A tab opened on the bad build before the rollback reloads itself the
first time it fails to load a deleted chunk (`apply/src/shell/stale.ts`).

## What to watch after a deploy

- `npm run check:html` against live (canonical, title, description,
  Open Graph, Twitter, JSON-LD, words, links, `<main>` text).
- The 404 status: `curl -s -o /dev/null -w "%{http_code}" https://oceanofjobs.com/jobs/x`
  must be 404.
- `/account/alerts` opens the account page, not the 404 page.
- The cookie banner, the "Log in" window and the theme switch on one page
  in each theme.
