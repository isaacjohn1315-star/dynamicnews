# DynaSport — Football News Automation

Automated pipeline that discovers important, fresh football news and publishes concise,
source-attributed updates to the DynaSport Facebook Page:

```
cron-job.org (every 10 minutes)
  → Authorization-protected /api/football/automation
  → anti-flood + popularity gate (rolling hour window, NO daily cap)
  → validated RSS feed discovery (sole source, no third-party API budget)
  → all-competition relevance + source-credibility filtering
  → duplicate detection (unique keys + cross-publisher story matching, corroboration-aware)
  → Neon PostgreSQL atomic publish claim (no double posts; failures stay retryable)
  → concise post: 🚩 statement + one blank line + "Source: …" (no links, no hashtags)
  → Meta Graph API POST /{page-id}/feed → DynaSport Facebook Page
  → database-backed monitoring, feed health and retry handling
```

## Stack

- Next.js (App Router) — monitoring dashboard at `/`, API routes only
- Neon PostgreSQL via `@neondatabase/serverless` (production, over HTTPS; no ORM)
- `pg` (node-postgres) is used **only** when `DATABASE_URL` is not a Neon host, so the app can be run and debugged locally. The Neon driver itself is HTTP-only and cannot talk to a local Postgres process; a Neon URL always takes the Neon driver, so production is unaffected and uses the same SQL.
- Validated public football RSS/Atom feeds — the only discovery source, no API budget or request ceiling
- Meta Graph API `v25.0` — Page text posts

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `FACEBOOK_PAGE_ID` | DynaSport Facebook Page ID |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Facebook Page access token |
| `FACEBOOK_APP_ID` | Meta app ID (read-only `/debug_token` health check only) |
| `FACEBOOK_APP_SECRET` | Meta app secret (health check only) |
| `CRON_SECRET` | Bearer secret for the automation endpoint |

See `.env.example`. Secrets are never logged, never sent to the browser, and never included in error messages. RSS feeds need no credentials.

## Database transport

`DATABASE_URL` is a Neon connection string in production (`*.neon.tech`), and the Neon serverless driver is used over HTTPS — the only transport that works well on Vercel's Node.js runtime. `/api/health` reports the active transport as `driver: "neon-https"`.

If `DATABASE_URL` points at a non-Neon host, the identical SQL runs over a standard Postgres TCP connection instead. This exists purely so the pipeline and dashboard can be exercised outside production; it is not a second database and never runs when a Neon URL is configured.

## Deployment (Vercel)

The project is a standard Next.js App Router application — Vercel detects it automatically with no additional configuration files:

1. Import the repository in Vercel and deploy. Build command `next build` and output are detected automatically.
2. In **Project Settings → Environment Variables**, add all seven variables from the table above (Production scope; `DATABASE_URL` must be the real Neon connection string). `.env` files are git-ignored, so no secrets ever enter source control.
3. All routes run on the Node.js serverless runtime; the automation route declares `maxDuration = 60`, which is valid on every Vercel plan including Hobby.
4. Database access uses the Neon serverless driver over HTTPS — purpose-built for Vercel serverless functions; no persistent connections, pooling, or local database required.
5. After the first deploy, create the cron-job.org job below against the production URL. Tables are created automatically on first run.

## cron-job.org setup

- **URL**: `https://<your-domain>/api/football/automation`
- **Schedule**: `*/2 * * * *` — every 2 minutes, **24/7** (~720 runs/day). Every minute also works; the app is safe at any frequency because of atomic claims, a single-flight lease and adaptive polling. Do not configure a time window or pause days.
- **Request header**: `Authorization: Bearer <CRON_SECRET>`

Manual runs and retries call the same endpoint with the same header, so every execution shares the same atomic request accounting.

## Discovery: RSS only, no API limits

NewsData.io has been **removed**. RSS feeds are the sole discovery source, which removes the 200-requests-per-day API ceiling entirely — capacity now scales with the feed registry and the configured cron interval instead of a third-party quota.

Everything is environment-driven; nothing is hardcoded:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRON_INTERVAL_MINUTES` | 2 | How often cron-job.org calls the endpoint |
| `FEED_BATCH_SIZE` | 180 | Feeds claimed per run |
| `FEED_CONCURRENCY` | 40 | Simultaneous outbound feed requests |
| `RUN_DEADLINE_MS` | 22000 | Hard ceiling per run (cron-job.org aborts at 30 s) |
| `MAX_POSTS_PER_HOUR` | 4 | Anti-flood rolling-hour ceiling (NOT a daily cap) |
| `MIN_SPACING_MINUTES` | 6 | Minimum minutes between posts |
| `POPULARITY_MIN_SCORE` | 65 | Editorial bar a story must clear |

## News discovery

- **RSS feeds — 624 validated public feeds** (`src/lib/feeds.ts`). Every URL was verified with a real HTTP request (200 + parseable RSS/Atom + >=3 items + usable timestamps) before inclusion. Coverage spans the Premier League and EFL, Scottish/Welsh/Irish and non-league football, all major European leagues, UEFA/FIFA competitions, international and women's football, plus club-, manager- and player-specific feeds. Fetched politely (timeout-bounded, `If-None-Match`/`If-Modified-Since`, rotation, backoff) with per-feed health in Neon. **Google News RSS was deliberately excluded** — its feed body carries an express restriction to personal, non-commercial use.
- RSS is the **only** publishing source; there is no third-party API in the discovery path.
- Stories are ranked by original publication timestamps, and nothing is presented as real-time breaking news when it is not.

## Continuous 24/7 operation

DynaSport runs continuously — no operating window, no overnight/weekend/holiday pause, and no dependency on a browser or manual start. The default interval is **every 2 minutes** (`CRON_INTERVAL_MINUTES`), roughly 720 runs/day, with no API budget to exhaust.

- Every run checks the anti-flood window and the popularity bar before publishing.
- When the budget is exhausted, RSS discovery and publishing continue unaffected.
- Transient failures (provider outage, feed error, Facebook hiccup) are recorded and recovered automatically on a later run — no manual intervention.
- Runs are bounded by `RUN_DEADLINE_MS` (default 22 s) because cron-job.org aborts a request after 30 seconds; any work that does not fit happens on the next run. Each run claims a bounded batch of due feeds (default 180) from the 624-feed catalogue.
- A Neon-backed **single-flight lease** stops overlapping executions from duplicating work; budget reservations and publication claims remain atomic regardless.
- Every run, error, fetch and publishing result is recorded in Neon.

## Duplicate protection (no story posted twice)

**One underlying story produces at most one normal Facebook post** — across all providers, feeds, publishers, manual runs and scheduled runs.

| Layer | Mechanism |
| --- | --- |
| **A · Exact article** | Provider article IDs, canonical/normalized URLs (tracking params stripped) and title+source+time fingerprints, enforced by a `UNIQUE` constraint on `news_items.dedupe_key` |
| **B · Same story** | Deterministic story fingerprint (actors + event kind, stage-independent) plus cross-publisher headline-similarity matching (≥4 shared meaningful tokens, ≥60% containment). A match adopts the existing story's fingerprint, so all reports canonicalize to one story |
| **C · Database claim** | `story_publications` primary key on `(fingerprint, stage_rank)` — concurrent runs physically cannot publish the same story stage twice. Published stories are permanently excluded from re-publication |
| **D · Follow-ups** | A second post is allowed **only** when the story advances to a materially new stage — a concrete **bid**, an **agreement**, or an **official** confirmation (max 2 follow-ups/story). Rumour→talks drift and reworded headlines never qualify |

Stage ladder: `general → rumour → talks → bid → agreement → official`.

Stale items (older than 48h) are rejected rather than published as breaking news, and a delayed free-plan article is never described as newly breaking. Publication states are `candidate → publishing → published / failed`, with uncertain Facebook outcomes reconciled against the live Page feed before any retry.

## Publishing pace (no daily cap)

**There is no daily Facebook posting limit.** DynaSport publishes every story that genuinely qualifies — if eight important new stories qualify in a day, all eight are published; if none qualify, nothing is published. Volume is governed by editorial quality, never by a counter.

Selection happens upstream in the relevance, freshness, source-credibility and duplicate layers, not in the publisher. Meta's Graph API imposes no fixed posts-per-day ceiling (its Page-level limits scale with engaged users over a rolling 24 hours), so no application-level ceiling is imposed either.

| Rule | Value |
| --- | --- |
| Daily post cap | **None** |
| Posts per automation run | 1 (always sequential, never batched) |
| Ordinary post spacing | 3 minutes (politeness only) |
| Top stories | Bypass spacing — confirmed announcements **and** significant rumours from credible reporters |

The 3-minute spacing exists only so Facebook has time to process each request. Two kinds of story skip it: confirmed announcements (official stage, score >=100) and **significant rumours from credible reporters** (score >=105). Rumours are treated as first-class football-news content — that is what football pages actually publish — but only credible sources can jump the queue, so aggregator blogs cannot. `next_eligible_publish_at` is persisted in Neon, so redeploys cannot reset it. A failed Facebook call returns the slot immediately.

## Freshness: breaking, fresh, trending, older

There is **no blanket age cut-off**. A story is classified, not simply discarded by age:

| Category | Window | Rule |
| --- | --- | --- |
| **Breaking** | <= 6 h | Confirmed development (agreement/official). Publish immediately after verification. |
| **Fresh** | <= 48 h | Important development. Publishes on its own merits. |
| **Trending** | 2-7 days | Publishes **only** when at least **2 distinct credible publishers** independently report it and the relevance score is >= 60. Always labelled trending, never described as newly breaking. |
| **Older** | > 7 days | Rejected unless it is a materially new development with its own event fingerprint. |

Corroboration is counted in `story_sources`, whose primary key is `(fingerprint, publisher)` — so **one outlet republishing five near-copies counts as breadth of one, not five**. No engagement or popularity numbers are invented: if there is no corroboration evidence, the story is scored on newsworthiness and freshness alone and is never claimed to be trending.

A trending story DynaSport has already posted is **not** re-posted for remaining popular; only a materially new development (new bid, official statement, agreement) qualifies.

### Timestamp semantics

`published_at` is the publisher's original time, `first_seen_at` is when DynaSport discovered the article, `last_seen_at` is the latest feed observation, and `updated_at` is row maintenance (never a publication date). Age is always measured from `published_at`, so re-fetching an old article can never make it look newly published. Timestamp parsing handles RFC-822 named zones (`BST`), ISO-8601/Atom, bare `YYYY-MM-DD HH:MM:SS` as UTC, and bare epoch values — detecting **seconds vs milliseconds** by magnitude rather than guessing. Missing, invalid, future-dated and implausible-year timestamps are rejected explicitly instead of being treated as fresh. The dashboard shows both, e.g. *"published 5 days ago · discovered 7 minutes ago"*.

## Post format## Post format

```
🚩 <headline>

<one or two sentences on why it matters and what is actually known>

Source: <real publisher>
```

Headline and explanation come only from the publisher's own headline and summary — no invented fees, quotes, statistics or outcomes. The certainty caveat is tied to the detected stage (interest / talks / bid / agreement / official). If no accurate explanation or trustworthy attribution can be produced, the story is rejected rather than padded with filler.

## Behaviour notes

- Each run publishes at most one queued story — sequential by design, never a batch. There is no daily cap; only burst flooding is limited.
- Responses stay small and fast so cron-job.org never times out or deprioritizes the job.
- Rumours are published hedged (prefixed `Report:`); only reported facts are stated plainly; attribution always uses the real publisher of the article.
- Duplicate reports of the same event across providers are merged via headline token containment (≥4 shared meaningful tokens, ≥60% containment); corroborated stories rank higher using internal evidence only.
- Failed Facebook posts return to the queue with exponential backoff; uncertain outcomes (timeouts) are reconciled against the Page feed before any retry to prevent duplicate posts. Items are marked published only after Meta confirms (or reconciliation finds) the post.
- Tables (`news_items`, `stories`, `story_publications`, `published_posts`, `story_sources`, `rss_feeds`, `feed_batches`, `article_cache`, `queue_resets`, `automation_runs`, `automation_lease`, `scan_state`, `publish_state`) are created automatically on first use.

## Routes

- `/` — operations dashboard (runs, budget, queue, duplicates, feed health, published posts, retries)
- `GET|POST /api/football/automation` — protected automation endpoint
- `GET /api/health` — liveness/readiness probe (reports database status)
