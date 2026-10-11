# DynaSport — Football News Automation

Automated pipeline that discovers important, fresh football news and publishes concise,
source-attributed updates to the DynaSport Facebook Page:

```
cron-job.org (every 10 minutes)
  → Authorization-protected /api/football/automation
  → shared atomic NewsData.io budget check (≤200/day UTC + rolling-24h guard, Neon-backed)
  → NewsData.io Latest News discovery (at most one request per run)
  → validated RSS feed discovery (zero NewsData credits; runs even when budget is exhausted)
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
- NewsData.io `GET /api/1/latest` — football discovery (server-side only, budget-gated)
- Validated public football RSS feeds — fresh discovery at zero NewsData credit cost
- Meta Graph API `v25.0` — Page text posts

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `NEWSDATA_API_KEY` | NewsData.io API key (server-side only) |
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
- **Schedule**: `*/10 * * * *` — every 10 minutes, **24/7** (144 scheduled runs/day, well inside the 200-request ceiling). Do not configure a time window or pause days.
- **Request header**: `Authorization: Bearer <CRON_SECRET>`

Manual runs and retries call the same endpoint with the same header, so every execution shares the same atomic request accounting.

## NewsData.io request budget (200/day, hard)

NewsData.io documents the free plan as **200 API credits/day** (1 credit per request, 10 articles per credit) with a **30-credits-per-15-minutes** rate limit and a **100-character** query limit. The exact daily reset timezone is **not** publicly documented, so enforcement is intentionally dual-window:

- A per-UTC-day counter guarded by a serialized `INSERT … ON CONFLICT` increment — concurrent executions cannot overshoot.
- A rolling 24-hour event ledger as a strictly conservative guard: usage stays within 200 in **any** 24h span under any provider reset semantics. It can only restrict, never permit more.
- Capacity is reserved atomically *before* each request and never refunded, so failed/retried requests are counted. Pagination is never auto-followed; at most one request per run.
- The 8-minute schedule peaks at ~8 requests per 15 minutes — comfortably inside the plan's 30-per-15-minute rate limit.
- Dashboard shows today's usage, remaining budget, rolling-24h usage, counter reset time, and last successful/failed fetch.

## Coverage: 90 football-news categories

The relevance engine recognises every story type a football news desk publishes, not just transfers:

- **Transfers** — interest, negotiations, bids, rejected bids, fees, valuations, release and buy-back clauses, loans, loan-with-option, free agents, failed and cancelled deals, deadline day, January and summer windows.
- **"Here We Go" and confirmations** — here-we-go announcements, official signings, medicals, personal terms, contract renewals, club statements.
- **Player news** — injuries, comebacks, retirements, milestones, disputes with clubs or managers, suspensions, disciplinary investigations, agents.
- **Manager and staff** — sackings, appointments, renewals, interviews, press conferences, sporting directors, tactical changes.
- **Match coverage** — results, starting and predicted line-ups, previews, reactions, post-match interviews, player ratings, goals and assists, records.
- **Club and finance** — ownership, takeovers, financial problems, FFP, points deductions, legal disputes, academy promotions, wonderkids, scouting.
- **Governance and international** — FIFA, UEFA, Premier League, Champions League, World Cup, national-team selections and injuries, Ballon d'Or and awards.
- **Culture** — dressing-room and training-ground reporting, VAR and referee controversy, derbies, rivalries, fan reaction, exclusive interviews, behind-the-scenes developments.

Scoring uses ~427 signal terms across confirmed, reported and contextual registers. Rumours and confirmed deals are treated as equally publishable; the difference is preserved in the wording. Aggregation digests (gossip columns, rumour round-ups) are rejected because they bundle many publishers' claims into one post that cannot be attributed to a single source. Predicted line-ups and expert opinion are accepted; betting tips, odds and listicles are not.

## News discovery

- **NewsData.io**: one broad sports-category, English-language football query per run; results processed locally (no per-club/per-player queries).
- **RSS feeds — 624 validated public feeds** (`src/lib/feeds.ts`). Every URL was verified with a real HTTP request (200 + parseable RSS/Atom + >=3 items + usable timestamps) before inclusion. Coverage spans the Premier League and EFL, Scottish/Welsh/Irish and non-league football, all major European leagues, UEFA/FIFA competitions, international and women's football, plus club-, manager- and player-specific feeds. Fetched politely (timeout-bounded, `If-None-Match`/`If-Modified-Since`, rotation, backoff) with per-feed health in Neon. **Google News RSS was deliberately excluded** — its feed body carries an express restriction to personal, non-commercial use.
- RSS is the **primary publishing source**; NewsData.io is used for corroboration and context only, never as breaking news.
- NewsData free-plan results can lag ~12h; stories are ranked by original publication timestamps, fresh RSS items outrank stale API items, and nothing is presented as real-time breaking news when it is not.

## Continuous 24/7 operation

DynaSport runs **every 10 minutes, around the clock** — no operating window, no overnight/weekend/holiday pause, and no dependency on a browser or manual start. Expected volume is **144 scheduled runs per 24h**, inside the 200-request NewsData.io ceiling with ample headroom for manual runs and retries.

- Every run independently verifies the remaining NewsData.io budget before making any request.
- When the budget is exhausted, RSS discovery and publishing continue unaffected.
- Transient failures (provider outage, feed error, Facebook hiccup) are recorded and recovered automatically on a later run — no manual intervention.
- Runs are bounded by a **22-second internal deadline** because cron-job.org aborts a request after 30 seconds; any work that does not fit happens on the next run. Each run polls a rotating slice of 14 feeds (least-recently-fetched first) from the 624-feed catalogue.
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
| NewsData.io API credits | 200/day — unchanged, an API protection limit |

The 3-minute spacing exists only so Facebook has time to process each request. Two kinds of story skip it: confirmed announcements (official stage, score >=100) and **significant rumours from credible reporters** (score >=105). Rumours are treated as first-class football-news content — that is what football pages actually publish — but only credible sources can jump the queue, so aggregator blogs cannot. `next_eligible_publish_at` is persisted in Neon, so redeploys cannot reset it. A failed Facebook call returns the slot immediately.

## Freshness: newly published only

- A story may be published only if its **original publication timestamp** is newer than the last successful scan checkpoint, bounded by a **60-minute recovery window**.
- Items with missing, unparseable, future-dated or untrustworthy timestamps are never published automatically.
- NewsData.io items are **never** publishing candidates (free-plan delivery can lag ~12h); they are stored for deduplication and context.
- Checkpoints advance only when discovery actually succeeded, so an outage cannot flood the Page with hours-old stories.
- All timestamps are stored and compared in UTC.

## Rumours vs confirmed deals

DynaSport reports rumours the way a football news page does: promptly, but never dressed up as fact.

- Every unconfirmed story carries a `Report:` prefix and an explicit certainty caveat tied to its detected stage (interest → talks → bid → agreement → official).
- Confirmed announcements are stated plainly, with no hedge.
- A story is never attributed to a reporter who did not actually write it; the named publisher of the article is used.
- No invented fees, quotes, sources, timelines or motives — only what the original report states.

## Post format

```
🚩 <headline>

<one or two sentences on why it matters and what is actually known>

Source: <real publisher>
```

Headline and explanation come only from the publisher's own headline and summary — no invented fees, quotes, statistics or outcomes. The certainty caveat is tied to the detected stage (interest / talks / bid / agreement / official). If no accurate explanation or trustworthy attribution can be produced, the story is rejected rather than padded with filler.

## Behaviour notes

- Each run publishes at most one queued story — sequential by design, never a batch. Discovery always runs (RSS keeps working after the NewsData budget is exhausted), and the publishing count is never capped.
- Responses stay small and fast so cron-job.org never times out or deprioritizes the job.
- Rumours are published hedged (prefixed `Report:`); only reported facts are stated plainly; attribution always uses the real publisher of the article.
- Duplicate reports of the same event across providers are merged via headline token containment (≥4 shared meaningful tokens, ≥60% containment); corroborated stories rank higher using internal evidence only.
- Failed Facebook posts return to the queue with exponential backoff; uncertain outcomes (timeouts) are reconciled against the Page feed before any retry to prevent duplicate posts. Items are marked published only after Meta confirms (or reconciliation finds) the post.
- Tables (`news_items`, `stories`, `story_publications`, `request_budget`, `request_events`, `rss_feeds`, `automation_runs`, `automation_lease`, `scan_state`, `publish_state`) are created automatically on first use.

## Routes

- `/` — operations dashboard (runs, budget, queue, duplicates, feed health, published posts, retries)
- `GET|POST /api/football/automation` — protected automation endpoint
- `GET /api/health` — liveness/readiness probe (reports database status)
