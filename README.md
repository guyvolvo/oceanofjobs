# Ocean of Jobs

Ocean of Jobs is an open-source job board that collects listings directly from company hiring systems. It tracks when jobs are added, changed, closed, or reposted, and makes the data available through a website, a public REST API, and an MCP server.

**Live site:** https://oceanofjobs.com

| Resource | URL |
|---|---|
| Job board | [/board](https://oceanofjobs.com/board) |
| Company directory | [/companies](https://oceanofjobs.com/companies) |
| Statistics | [/stats](https://oceanofjobs.com/stats) |
| Documentation | [/docs](https://oceanofjobs.com/docs) |
| REST API | [/docs/api](https://oceanofjobs.com/docs/api) |
| MCP server | [/mcp](https://oceanofjobs.com/mcp) |
| License | MIT |

## Using the MCP server

The MCP server lets AI assistants search the job database, retrieve full job descriptions, and look up companies. It uses Streamable HTTP and requires no API key or account.

Server URL: `https://oceanofjobs.com/mcp`

For example, you can ask an assistant to find remote Kubernetes jobs posted this week or check which positions a company is hiring for in Tel Aviv.

Setup guides are available in the [MCP documentation](https://oceanofjobs.com/docs/mcp).

| Client | Setup |
|---|---|
| Claude Code | `claude mcp add --transport http oceanofjobs https://oceanofjobs.com/mcp` |
| Claude (web and desktop) | Settings → Customize → Connectors → Add custom connector |
| ChatGPT | Settings → Apps & Connectors → Developer mode → Create |
| Cursor | One-click install or `~/.cursor/mcp.json` |
| VS Code | One-click install or `code --add-mcp` |
| Gemini CLI | `gemini mcp add -s user --transport http oceanofjobs https://oceanofjobs.com/mcp` |
| Codex | `codex mcp add oceanofjobs --url https://oceanofjobs.com/mcp` |
| Hermes Agent | `hermes mcp add oceanofjobs --url https://oceanofjobs.com/mcp` |
| Kimi Code | `/mcp-config` or an entry in `mcp.json` |

Any client that supports Streamable HTTP can connect using the same URL.

### Available tools

The server exposes three read-only tools:

- **`search_jobs`** searches job titles, companies, locations, and descriptions. Filters include company, city, country, seniority, workplace type, posting age, and minimum monthly salary in shekels.
- **`get_job`** retrieves a listing's full description (up to 6,000 characters), application link, and information about other listings of the same posting.
- **`get_company`** looks up a company by name or domain and returns its open-job count, jobs added this week, tracking history, and newest listings.

Each call returns up to 25 results, with an offset limit of 200. Responses can be cached at the edge for up to five minutes. Once the daily free capacity is exhausted, requests return a JSON-RPC error until 00:00 UTC. See the [MCP documentation](https://oceanofjobs.com/docs/mcp) for current limits.

For bulk queries, use the [REST API](https://oceanofjobs.com/docs/api).

The server runs as a Cloudflare Worker in `infra/mcp-worker.mjs`, deployed as `otj-mcp` by `scripts/deploy_mcp_worker.py`. It is stateless: each tool call becomes a GET request to the public API, with parameters in a consistent order so Cloudflare can cache identical requests. A per-location rate limit controls cache misses. The MCP server has its own route and can be disabled without affecting the job board.

## Architecture

The data pipeline runs on AWS, with Cloudflare handling routing and caching. SQLite stores the job and company records on a single EC2 instance, while scraping runs separately on Lambda and GitHub Actions.

The full design, including failure modes and operational runbooks, is documented in [ARCHITECTURE.md](ARCHITECTURE.md).

### Data collection and ingestion

```text
GitHub Actions ──► S3 ──► EC2 ingestion ──► SQLite
     discovery           fragment fetcher     jobs.db
                         and applier           jobs-fts.db

EventBridge ──► Lambda ──► S3
                polling     delta fragments

Browser ──► Cloudflare ──► API on EC2
AI client ──► MCP Worker ──► Public API
```

The production database runs on an EC2 `t4g.medium` instance in `il-central-1`. `jobs.db` stores listings and company data; `jobs-fts.db` contains the full-text search index. Both are continuously replicated to S3 using Litestream.

Scraping and database ingestion are kept separate. Lambda checks hiring-system endpoints and writes changes to S3, while the EC2 instance applies those changes to SQLite and serves queries. Most polls return `304 Not Modified`, so checking for changes is relatively inexpensive.

All write-heavy operations on the instance, including ingestion, publishing, and snapshots, use the file lock in `box/lock.py` to avoid SQLite write contention.

### 1. Scraping and ingestion

`probe.py` handles conditional HTTP requests against hiring systems, including Greenhouse, Lever, Ashby, and SmartRecruiters. It uses `If-None-Match` headers to avoid downloading unchanged data.

- **`scrape_handler.py`** runs on Lambda every five minutes and writes changed data as fragments to S3.
- **Adaptive polling** checks active boards every five minutes. Inactive boards back off exponentially, up to four hours, and return to five-minute polling when new jobs appear.
- **`scrape_workday_handler.py`** runs hourly for Workday and other heavier or custom sources listed in `companies.yml`, including Oracle and Eightfold.
- **`box/fetch_fragments.py`** copies fragments from S3 to a local spool every 30 seconds.
- **`box/shadow_apply.py`** applies the fragments in 48 MB passes.

The S3 fragment queue separates scraping from database writes and prevents ingestion from racing with fragment deletion.

### 2. API and request routing

The API is a Python WSGI application in `api/handler.py`, served by Gunicorn with two workers and four threads per worker.

Requests are routed as follows:

| Route | Destination | Purpose |
|---|---|---|
| `/api/auth/*` | CloudFront → Lambda | Sign-in flows |
| `/api/*` | Cloudflare Worker → cloudflared → EC2 | API requests |
| `/mcp` | MCP Worker → public API | AI assistant access |
| `/job/*`, `/company/*` | CloudFront → cloudflared → EC2 | Server-rendered pages |
| `/docs/*` | CloudFront → S3 | Documentation |
| `/*` | CloudFront → S3 | Static frontend |

CloudFront also serves as a fallback for `/api/*`. When the API Worker reaches its free-plan limit of 100,000 requests per day, the route fails over to CloudFront and continues reaching the same EC2 origin through the tunnel. This fallback is roughly 100 ms slower and less consistent.

On September 25, 2026, a crawler exhausted the Worker budget by requesting `/job/*` pages. Those pages now go through CloudFront, which has a free allowance of ten million requests per month.

The previous Lambda-based API deployment remains available as a rollback option. Switching the routing back to the `api-lambda` origin restores that setup.

### 3. Company discovery

GitHub Actions runs a daily discovery job that scans the Common Crawl URL index, checks candidate hiring endpoints, collects domains in `domains.txt`, and resolves company identities.

Known or unusual hiring systems can also be configured explicitly in `companies.yml`.

### 4. Search-engine pages and feeds

Each job has a server-rendered page at `/job/<id>` with `JobPosting` structured data. Company pages are available at `/company/<domain>`.

When a job closes, its page remains available for 30 days with a closed status and a `noindex` directive. After that, the server returns HTTP 410.

`loader/sitemap.py` runs as part of the publishing job, which runs at most every six hours. It generates:

- `sitemap.xml` and its sitemap shards
- `feed.xml`, an RSS feed containing the 100 newest listings
- A company directory at `/companies/a` through `/companies/z`

The company directory uses ordinary links to company pages, allowing crawlers to discover listings without executing JavaScript.

### 5. Monitoring and alerts

CloudWatch alarms, defined in `infra/alarms.tf`, send email through SNS when a data source goes stale, the fast scraper fails or runs slowly, or the fragment backlog grows.

A Grafana dashboard reads CloudWatch metrics to track database growth and search activity. User email alerts are sent through Amazon SES.

## Storage and search

Job descriptions are stored individually in S3 and retrieved when needed. Raw JSON payloads are discarded after processing.

Search uses a contentless SQLite FTS5 index stored separately in `jobs-fts.db`. Keeping the index separate from `jobs.db` means it can be rebuilt or vacuumed without locking the main database.

The full-text index is approximately 1.8 GB, compared with roughly 0.8 GB for `jobs.db`.

New listings typically appear on the site within about five minutes of being posted. Changes generally reach the EC2 ingestion process within one to two minutes of their fragments arriving.

## Authentication

Browsing and searching public listings require no account.

Users can optionally create an account to save filters and receive email alerts. Authentication uses AWS Cognito with Google OAuth, a custom Lambda flow for GitHub OAuth, and passwordless email OTP.

## Repository structure

| Path | Purpose |
|---|---|
| `probe.py` | Hiring-system scraper with conditional HTTP requests |
| `companies.yml` | Configuration for Workday, Comeet, and custom hiring portals |
| `domains.txt` | Discovered and resolved target domains |
| `db/schema.sql` | Database schema, including the contentless FTS5 table |
| `loader/` | S3 description storage, delta handling, and SQLite upserts |
| `box/` | EC2-side fragment fetching, ingestion, publishing, and locking |
| `api/` | Python WSGI application and API endpoints |
| `alerts.py` | Saved-search evaluation and email dispatch |
| `frontend/` | Static frontend pages, CSS, and JavaScript |
| `docs/` | Next.js and Fumadocs documentation, exported as static files |
| `infra/` | Terraform for AWS resources and Cloudflare routing, including both Workers |
| `scripts/` | Deployment, live checks, origin-key rotation, DNS, quota checks, and local preview |
| `ARCHITECTURE.md` | Detailed system design, failure modes, and operational runbooks |
| `.github/workflows/` | CI/CD for discovery, infrastructure, API, EC2 services, scrapers, frontend, and documentation |

The frontend uses plain HTML, CSS, and JavaScript without a frontend framework. Its pages cover the job board, company directory, statistics, accounts, contact, and privacy. The documentation site is built with Next.js and Fumadocs and exported to static files.

## License

MIT
