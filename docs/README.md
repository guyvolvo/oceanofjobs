# Docs

The docs at https://oceanofjobs.com/docs: the MCP server and the REST API.
A Fumadocs app (Next.js), exported as static files. The rest of the site
stays framework-less; this folder is the only one with a build step.

    npm ci
    npm run dev      # http://localhost:3000/docs
    npm run build    # static files in out/

Pages are MDX in `content/docs`. The API reference under
`content/docs/api/reference` is generated on every build from the live
https://oceanofjobs.com/api/openapi.json (`scripts/generate-api.mjs`) and
is not committed.

`.github/workflows/deploy-frontend.yml` builds it and syncs `out/` to the
bucket's `docs/` prefix. CloudFront's request function serves `/docs/x`
from `docs/x.html` (`infra/cloudfront.tf`).
