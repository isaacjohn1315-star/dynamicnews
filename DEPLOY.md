# DynaSport — Deployment & Vercel troubleshooting

## THE FIX for your current build error

Error: `./src/lib/newsdata.ts:2:10 — Type error: Module '"./env"' has no
exported member 'newsdataApiKey'`.

**Why it happens:** *"Add files via upload" never deletes files.* My source
code deleted `src/lib/newsdata.ts` (and others), but your Vercel tree still
contains it. You uploaded the new `src/lib/env.ts` (which no longer exports
`newsdataApiKey`) while the old `newsdata.ts` still imports it — a
mismatch. Uploading **changes files but never removes them**, so every file
I've ever deleted still lives on your Vercel and keeps breaking builds.

### Immediate fix (Vercel web UI)
Open your project → **Deploy** or the file browser, and DELETE these stale
files (they no longer exist in the source and WILL cause this and the next
errors):

| File to DELETE | The next error it would cause |
| --- | --- |
| `src/lib/newsdata.ts` | ← current error (`newsdataApiKey` gone) |
| `src/lib/request-budget.ts` | dead module, references removed tables |
| `src/db/index.ts` and `src/db/schema.ts` | imports `drizzle-orm`, which is **not** in package.json → next failure |
| `drizzle.config.json` | obsolete |
| `app.tsx`, any Vite/CRA files | wrong framework |

Then redeploy. The tree on Vercel must look exactly like the manifest below.

### Permanent fix (do this instead of manual uploading)
This kept happening because uploads are partial. **Connect the Git repo
instead**: Vercel → Add New → Project → Import from GitHub, pick your repo.
Every push then deploys the **entire** tree atomically — files added,
changed AND deleted together — so a stale file like `newsdata.ts` can never
survive. Stop using "Add files via upload" for ongoing development.

## File manifest — what a deployable tree contains

src/ must contain **exactly** these 28 files; nothing else, nothing deleted:

- src/app/api/football/automation/route.ts
- src/app/api/football/feeds/route.ts
- src/app/api/health/route.ts
- src/app/globals.css, layout.tsx, page.tsx
- src/lib/article.ts, automation.ts, compose.ts, config.ts, dashboard.ts,
  db.ts, dedupe.ts, env.ts, facebook.ts, feed-registry.ts, feeds.ts,
  flood.ts, format.ts, freshness.ts, image.ts, lifecycle.ts,
  publishing.ts, queue.ts, relevance.ts, rss.ts, story.ts, text.ts

Root must contain: README.md, eslint.config.mjs, next.config.ts,
package.json, package-lock.json, postcss.config.mjs, tsconfig.json,
.env.example, DEPLOY.md, DEPLOY-FIX.md.

After a full clean upload the build passes (verified locally with the same
`npm run build` Vercel runs).
