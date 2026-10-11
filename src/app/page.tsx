import {
  Activity,
  AppWindow,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Database,
  Flag,
  Funnel,
  Gauge,
  GitBranch,
  KeyRound,
  Newspaper,
  RefreshCw,
  Infinity as InfinityIcon,
  Rss,
  Send,
  Share2,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  getDashboardData,
  type DashboardData,
  type DashboardFeed,
  type DashboardRun,
  type DashboardStory,
} from "@/lib/dashboard";
import { configPresence } from "@/lib/env";
import { checkPageTokenHealth, type PageTokenHealth } from "@/lib/facebook";
import { formatDateTime, formatInteger, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default async function DashboardPage() {
  const [data, tokenHealth] = await Promise.all([getDashboardData(), checkPageTokenHealth()]);
  const config = configPresence();

  return (
    <main className="min-h-screen bg-[#070b08] text-zinc-100 antialiased">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(52rem 26rem at 78% -10%, rgba(190,242,100,0.09), transparent 60%), radial-gradient(40rem 22rem at -10% 110%, rgba(34,197,94,0.07), transparent 55%)",
        }}
      />
      <div className="relative mx-auto max-w-6xl px-5 pb-20 pt-10 sm:px-8">
        <Header generatedAt={data?.generatedAt ?? null} online={data !== null} />

        <ConfigStrip config={config} tokenHealth={tokenHealth} />

        {data === null ? (
          <OfflineState />
        ) : (
          <>
            <section className="mt-8 grid gap-4 lg:grid-cols-3">
              <BudgetCard data={data} />
              <KpiGrid totals={data.totals} />
            </section>

            <section className="mt-4 grid gap-4 lg:grid-cols-5">
              <RunsCard runs={data.recentRuns} />
              <StoriesCard stories={data.recentStories} />
            </section>

            <section className="mt-4 grid gap-4 lg:grid-cols-5">
              <PublishedCard posts={data.recentPublished} />
              <FeedsCard feeds={data.feeds} />
            </section>

            <section className="mt-4 grid gap-4 lg:grid-cols-5">
              <ContinuousCard runsToday={data.totals.runsToday} lastRun={data.lastRun} />
              <DuplicateShieldCard totals={data.totals} />
            </section>

            <section className="mt-4">
              <PipelineCard lastRun={data.lastRun} feedCount={data.feeds.length} />
            </section>
          </>
        )}

        <footer className="mt-12 border-t border-white/5 pt-6 text-center text-xs text-zinc-500">
          DynaSport Operations — NewsData.io + validated RSS feeds → relevance engine → Neon → Meta Graph API.
          No public content is served here.
        </footer>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function Header({ generatedAt, online }: { generatedAt: string | null; online: boolean }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex items-center gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-lime-300/30 bg-lime-300/10 shadow-[0_0_40px_rgba(190,242,100,0.15)]">
          <Flag className="h-5 w-5 text-lime-300" strokeWidth={2.2} />
        </div>
        <div>
          <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
            Dyna<span className="text-lime-300">Sport</span>
          </h1>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-400">
            Football news automation — operations
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${
            online
              ? "border-lime-300/25 bg-lime-300/10 text-lime-200"
              : "border-amber-300/25 bg-amber-300/10 text-amber-200"
          }`}
        >
          <span className="relative flex h-2 w-2">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
                online ? "bg-lime-300" : "bg-amber-300"
              }`}
            />
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${online ? "bg-lime-300" : "bg-amber-300"}`}
            />
          </span>
          {online ? "Live" : "Awaiting database"}
        </span>
        {generatedAt && (
          <span className="hidden items-center gap-1.5 text-xs text-zinc-500 sm:inline-flex">
            <Clock className="h-3.5 w-3.5" />
            {formatDateTime(generatedAt)} UTC
          </span>
        )}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Config strip                                                        */
/* ------------------------------------------------------------------ */

function ConfigStrip({
  config,
  tokenHealth,
}: {
  config: ReturnType<typeof configPresence>;
  tokenHealth: PageTokenHealth;
}) {
  return (
    <section className="mt-8 flex flex-wrap items-center gap-2">
      <ConfigChip ok={config.database} label="Neon database" icon={<Database className="h-3.5 w-3.5" />} />
      <ConfigChip ok={config.newsdata} label="NewsData.io key" icon={<Newspaper className="h-3.5 w-3.5" />} />
      <ConfigChip ok={config.facebookPage} label="Facebook Page token" icon={<Share2 className="h-3.5 w-3.5" />} />
      <ConfigChip ok={config.facebookApp} label="Meta app credentials" icon={<AppWindow className="h-3.5 w-3.5" />} optional />
      <ConfigChip ok={config.cronSecret} label="Cron secret" icon={<KeyRound className="h-3.5 w-3.5" />} />
      <TokenChip health={tokenHealth} enabled={config.facebookPage && config.facebookApp} />
    </section>
  );
}

function ConfigChip({
  ok,
  label,
  icon,
  optional = false,
}: {
  ok: boolean;
  label: string;
  icon: ReactNode;
  optional?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
        ok
          ? "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200"
          : optional
            ? "border-zinc-400/15 bg-white/[0.03] text-zinc-400"
            : "border-red-300/25 bg-red-300/[0.08] text-red-200"
      }`}
    >
      {icon}
      {label}
      {ok ? (
        <CircleCheck className="h-3.5 w-3.5 text-emerald-300" />
      ) : optional ? (
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">not set</span>
      ) : (
        <CircleX className="h-3.5 w-3.5 text-red-300" />
      )}
    </span>
  );
}

function TokenChip({ health, enabled }: { health: PageTokenHealth; enabled: boolean }) {
  const styles: Record<PageTokenHealth["status"], string> = {
    valid: "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200",
    invalid: "border-red-300/25 bg-red-300/[0.08] text-red-200",
    expired: "border-red-300/25 bg-red-300/[0.08] text-red-200",
    unknown: "border-zinc-400/15 bg-white/[0.03] text-zinc-400",
  };
  const labels: Record<PageTokenHealth["status"], string> = {
    valid: "Page token valid",
    invalid: "Page token invalid",
    expired: "Page token expired",
    unknown: enabled ? "Token check unavailable" : "Token check not configured",
  };
  return (
    <span
      title={health.detail ?? health.scopes?.join(", ") ?? undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${styles[health.status]}`}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      {labels[health.status]}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 backdrop-blur-sm ${className}`}>
      {children}
    </div>
  );
}

function SectionLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-lime-200/60">
      {icon}
      {children}
    </h2>
  );
}

function BudgetCard({ data }: { data: DashboardData }) {
  const { used, limit, remaining, rolling24h, limitReachedAt, resetsAt } = data.budget;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const reached = limitReachedAt !== null || used >= limit;

  return (
    <Card className="lg:col-span-1">
      <SectionLabel icon={<Gauge className="h-3.5 w-3.5" />}>NewsData.io budget</SectionLabel>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-mono text-5xl font-bold tabular-nums text-white">{formatInteger(used)}</span>
        <span className="font-mono text-lg tabular-nums text-zinc-500">/ {limit}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        requests today ({data.budget.day} UTC) · <span className="text-zinc-300">{remaining} remaining</span>
      </p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className={`h-full rounded-full transition-all ${reached ? "bg-red-400" : "bg-lime-300"}`}
          style={{ width: `${Math.max(percent, used > 0 ? 2 : 0)}%` }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{percent}% used</span>
        {reached ? (
          <span className="inline-flex items-center gap-1 font-medium text-red-300">
            <TriangleAlert className="h-3 w-3" /> daily limit reached
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-medium text-lime-200/80">
            <CircleCheck className="h-3 w-3" /> capacity available
          </span>
        )}
      </div>

      <dl className="mt-4 space-y-2 border-t border-white/[0.06] pt-4 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Rolling 24h guard</dt>
          <dd className="font-mono tabular-nums text-zinc-300">{rolling24h}/{limit}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Counter resets</dt>
          <dd className="font-mono tabular-nums text-zinc-300">{formatDateTime(resetsAt)} UTC</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Last successful fetch</dt>
          <dd className="font-mono tabular-nums text-emerald-300/90">
            {data.newsdataHealth.lastSuccessAt ? timeAgo(data.newsdataHealth.lastSuccessAt) : "none yet"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Last failed fetch</dt>
          <dd
            className="font-mono tabular-nums text-amber-300/90"
            title={data.newsdataHealth.lastFailureError ?? undefined}
          >
            {data.newsdataHealth.lastFailureAt ? timeAgo(data.newsdataHealth.lastFailureAt) : "none"}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function KpiGrid({ totals }: { totals: DashboardData["totals"] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:col-span-2">
      <Kpi icon={<Send className="h-4 w-4" />} label="Published today" value={totals.publishedToday} sub={`${formatInteger(totals.publishedTotal)} all time`} tone="lime" />
      <Kpi icon={<Timer className="h-4 w-4" />} label="Publishing queue" value={totals.queue} sub={`${formatInteger(totals.awaitingRetry)} awaiting retry`} tone="sky" />
      <Kpi icon={<Copy className="h-4 w-4" />} label="Duplicates blocked" value={totals.duplicates} sub={`${formatInteger(totals.exactDuplicates)} exact · ${formatInteger(totals.storyDuplicates)} same story`} tone="violet" />
      <Kpi icon={<Funnel className="h-4 w-4" />} label="Filtered out" value={totals.rejected} sub={`${formatInteger(totals.rejectedStale)} stale · rest irrelevant`} tone="zinc" />
      <Kpi icon={<TriangleAlert className="h-4 w-4" />} label="Failed posts" value={totals.failed} sub="retry-safe, never lost" tone="red" />
      <Kpi icon={<GitBranch className="h-4 w-4" />} label="Follow-ups posted" value={totals.followups} sub="materially new developments" tone="amber" />
    </div>
  );
}

const KPI_TONES: Record<string, string> = {
  lime: "text-lime-300 border-lime-300/20 bg-lime-300/[0.06]",
  sky: "text-sky-300 border-sky-300/20 bg-sky-300/[0.06]",
  violet: "text-violet-300 border-violet-300/20 bg-violet-300/[0.06]",
  red: "text-red-300 border-red-300/20 bg-red-300/[0.06]",
  amber: "text-amber-300 border-amber-300/20 bg-amber-300/[0.06]",
  zinc: "text-zinc-300 border-white/10 bg-white/[0.04]",
};

function Kpi({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  tone: keyof typeof KPI_TONES;
}) {
  return (
    <Card>
      <div className={`inline-grid h-8 w-8 place-items-center rounded-lg border ${KPI_TONES[tone]}`}>{icon}</div>
      <div className="mt-3 font-mono text-3xl font-bold tabular-nums text-white">{formatInteger(value)}</div>
      <div className="mt-1 text-xs font-medium text-zinc-300">{label}</div>
      <div className="text-[11px] text-zinc-500">{sub}</div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Runs + stories tables                                               */
/* ------------------------------------------------------------------ */

function RunsCard({ runs }: { runs: DashboardRun[] }) {
  return (
    <Card className="lg:col-span-2">
      <SectionLabel icon={<RefreshCw className="h-3.5 w-3.5" />}>Recent automation runs</SectionLabel>
      {runs.length === 0 ? (
        <EmptyState text="No automation runs recorded yet. cron-job.org triggers /api/football/automation every 8 minutes." />
      ) : (
        <ul className="mt-4 space-y-2">
          {runs.map((run) => (
            <li key={run.id} className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <RunStatusBadge status={run.status} />
                  <span className="text-xs text-zinc-400">{formatDateTime(run.startedAt)} UTC</span>
                </div>
                <span className="text-[11px] text-zinc-500">{timeAgo(run.startedAt)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-500">
                <span title="NewsData.io requests used">req <span className="text-zinc-200">{run.newsdataRequests}</span></span>
                <span title="NewsData articles fetched">nd <span className="text-zinc-200">{run.fetched}</span></span>
                <span title="RSS articles fetched">rss <span className="text-zinc-200">{run.rssFetched}</span></span>
                <span title="New stories queued">queued <span className="text-zinc-200">{run.newCandidates + run.rssNewCandidates}</span></span>
                <span title="Exact article duplicates">exact <span className="text-zinc-200">{run.exactDuplicates}</span></span>
                <span title="Same-story duplicates across publishers">story <span className="text-zinc-200">{run.storyDuplicates}</span></span>
                <span title="Follow-ups accepted (materially new development)">follow <span className="text-amber-300">{run.followupsAccepted}</span></span>
                <span title="Filtered out as irrelevant">filtered <span className="text-zinc-200">{run.rejected}</span></span>
                <span title="Feeds healthy">feeds <span className="text-zinc-200">{run.feedsOk}/{run.feedsChecked}</span></span>
                <span title="Posts published to Facebook">posted <span className="text-lime-300">{run.published}</span></span>
              </div>
              {(run.discoveryError || run.publishError || run.error) && (
                <p className="mt-2 truncate text-[11px] text-amber-300/80">
                  {run.publishError ?? run.discoveryError ?? run.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: ReactNode }> = {
    ok: { cls: "border-lime-300/25 bg-lime-300/10 text-lime-200", icon: <CircleCheck className="h-3 w-3" /> },
    budget_exhausted: { cls: "border-amber-300/25 bg-amber-300/10 text-amber-200", icon: <Gauge className="h-3 w-3" /> },
    error: { cls: "border-red-300/25 bg-red-300/10 text-red-200", icon: <CircleX className="h-3 w-3" /> },
    skipped_overlap: { cls: "border-zinc-400/20 bg-white/[0.04] text-zinc-300", icon: <Timer className="h-3 w-3" /> },
  };
  const entry = map[status] ?? map.ok;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${entry.cls}`}>
      {entry.icon}
      {status.replace("_", " ")}
    </span>
  );
}

function StoriesCard({ stories }: { stories: DashboardStory[] }) {
  return (
    <Card className="lg:col-span-3">
      <SectionLabel icon={<Newspaper className="h-3.5 w-3.5" />}>Latest discovered stories</SectionLabel>
      {stories.length === 0 ? (
        <EmptyState text="No stories discovered yet. New items appear after the next scheduled run." />
      ) : (
        <ul className="mt-4 divide-y divide-white/[0.05]">
          {stories.map((story) => (
            <li key={story.id} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-200" title={story.title}>
                  {story.isFollowup && (
                    <span className="mr-1.5 rounded bg-amber-300/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                      Follow-up
                    </span>
                  )}
                  {story.isRumour && (
                    <span className="mr-1.5 rounded bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                      Report
                    </span>
                  )}
                  {story.title}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                  <ProviderBadge provider={story.provider} feedName={story.feedName} />
                  <span>{story.sourceName ?? "unknown source"}</span>
                  <span>· score {story.relevanceScore}</span>
                  {story.corroborations > 1 && (
                    <span title="Independently reported by multiple captured sources">
                      · {story.corroborations} sources
                    </span>
                  )}
                  {story.storyStage && story.storyStage !== "general" && (
                    <span title="Reported stage of the underlying story">· {story.storyStage}</span>
                  )}
                  <span>· {timeAgo(story.createdAt)}</span>
                </p>
                {story.status === "duplicate" && (
                  <p className="mt-0.5 text-[11px] text-violet-300/70">
                    {story.duplicateKind === "story"
                      ? "same underlying story — not re-posted"
                      : "exact article already processed"}
                  </p>
                )}
                {story.status === "rejected" && story.decisionReason && (
                  <p className="mt-0.5 text-[11px] text-zinc-600">{story.decisionReason}</p>
                )}
                {story.status === "failed" && (
                  <p className="mt-0.5 text-[11px] text-red-300/70" title={story.lastError ?? undefined}>
                    unpublished after {story.attempts} attempts{story.lastError ? ` — ${story.lastError}` : ""}
                  </p>
                )}
                {story.status === "candidate" && story.attempts > 0 && story.nextRetryAt && (
                  <p className="mt-0.5 text-[11px] text-amber-300/70">
                    retry #{story.attempts + 1} at {formatDateTime(story.nextRetryAt)} UTC
                  </p>
                )}
              </div>
              <StatusBadge status={story.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProviderBadge({ provider, feedName }: { provider: "newsdata" | "rss"; feedName: string | null }) {
  if (provider === "rss") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-cyan-300/20 bg-cyan-300/[0.08] px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-cyan-200">
        <Rss className="h-2.5 w-2.5" /> {feedName ?? "RSS"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.05] px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-zinc-300">
      NewsData
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  published: "border-lime-300/25 bg-lime-300/10 text-lime-200",
  candidate: "border-sky-300/25 bg-sky-300/10 text-sky-200",
  publishing: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  failed: "border-red-300/25 bg-red-300/10 text-red-200",
  rejected: "border-white/10 bg-white/[0.04] text-zinc-400",
  duplicate: "border-violet-300/25 bg-violet-300/10 text-violet-200",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.rejected;
  return (
    <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Published + feeds + pipeline                                        */
/* ------------------------------------------------------------------ */

function PublishedCard({ posts }: { posts: DashboardStory[] }) {
  return (
    <Card className="lg:col-span-2">
      <SectionLabel icon={<Send className="h-3.5 w-3.5" />}>Published to Facebook</SectionLabel>
      {posts.length === 0 ? (
        <EmptyState text="Nothing published yet. Relevant stories are posted automatically after filtering." />
      ) : (
        <ul className="mt-4 space-y-3">
          {posts.map((post) => (
            <li key={post.id} className="rounded-xl border border-lime-300/[0.08] bg-lime-300/[0.03] px-3.5 py-3">
              <p className="text-sm leading-snug text-zinc-100">
                <span className="mr-1.5 text-lime-300">🚩</span>
                {post.title}
              </p>
              <p className="mt-1.5 text-[11px] text-zinc-400">Source: {post.sourceName ?? "unknown"}</p>
              <p className="mt-1 font-mono text-[10px] tabular-nums text-zinc-600">
                {timeAgo(post.postedAt)} · {post.fbPostId ?? ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const FEED_STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  ok: { cls: "border-lime-300/25 bg-lime-300/10 text-lime-200", label: "ok" },
  not_modified: { cls: "border-zinc-400/20 bg-white/[0.04] text-zinc-300", label: "unchanged" },
  error: { cls: "border-red-300/25 bg-red-300/10 text-red-200", label: "error" },
  skipped_backoff: { cls: "border-amber-300/25 bg-amber-300/10 text-amber-200", label: "backoff" },
};

function FeedsCard({ feeds }: { feeds: DashboardFeed[] }) {
  return (
    <Card className="lg:col-span-3">
      <SectionLabel icon={<Rss className="h-3.5 w-3.5" />}>News sources & feed health</SectionLabel>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Validated, publicly accessible RSS feeds — fetched with conditional requests and automatic backoff.
        RSS discovery consumes zero NewsData.io credits.
      </p>
      {feeds.length === 0 ? (
        <EmptyState text="Feeds register automatically on the next automation run." />
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {feeds.map((feed) => {
            const status = feed.lastStatus ?? "unknown";
            const entry = FEED_STATUS_STYLES[status] ?? FEED_STATUS_STYLES.error;
            return (
              <li
                key={feed.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-200">{feed.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600" title={feed.url}>
                    {hostOf(feed.url)} · {feed.itemsSeen} items
                    {feed.lastFetchedAt ? ` · ${timeAgo(feed.lastFetchedAt)}` : " · not fetched yet"}
                    {feed.consecutiveFailures > 0 ? ` · ${feed.consecutiveFailures} failures` : ""}
                  </p>
                  {status === "error" && feed.lastError && (
                    <p className="mt-0.5 truncate text-[10px] text-red-300/70" title={feed.lastError}>
                      {feed.lastError}
                    </p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${entry.cls}`}>
                  {entry.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function PipelineCard({ lastRun, feedCount }: { lastRun: DashboardRun | null; feedCount: number }) {
  return (
    <Card>
      <SectionLabel icon={<Zap className="h-3.5 w-3.5" />}>Production pipeline</SectionLabel>

      <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-[11px] font-medium text-zinc-400">
        {[
          "cron-job.org · every 8 min",
          "Bearer-protected endpoint",
          "budget check ≤ 200/day",
          "NewsData.io discovery",
          `${feedCount} validated RSS feeds`,
          "relevance filter",
          "duplicate shield",
          "Neon atomic claim",
          "🚩 post builder",
          "Meta Graph API",
          "Facebook Page",
        ].map((step, index, all) => (
          <li key={step} className="flex items-center gap-2">
            <span className="rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1">{step}</span>
            {index < all.length - 1 && <span className="text-zinc-600">→</span>}
          </li>
        ))}
      </ol>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Post format (exact)</p>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">
            {"🚩 Real Madrid plan to sign a world-class CB next summer.\n\nSource: Fabrizio Romano"}
          </pre>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            One blank line before the source line. No links, no hashtags. Rumours are always prefixed with
            &quot;Report:&quot; and never stated as confirmed fact. Attribution uses the actual publisher or
            reporter of the discovered article.
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">cron-job.org setup</p>
          <dl className="mt-2 space-y-1.5 font-mono text-[11px] text-zinc-400">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-zinc-600">URL</dt>
              <dd className="break-all">/api/football/automation</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-zinc-600">Schedule</dt>
              <dd>*/8 * * * * (every 8 minutes)</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-zinc-600">Header</dt>
              <dd className="break-all">Authorization: Bearer &lt;CRON_SECRET&gt;</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-zinc-600">Last run</dt>
              <dd>{lastRun ? `${formatDateTime(lastRun.startedAt)} UTC (${lastRun.status.replace("_", " ")})` : "none yet"}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Manual runs and retries use the same endpoint and the same shared daily counter — the 200-request
            cap cannot be bypassed.
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-black/30 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Data freshness</p>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            NewsData.io free-plan results can be delayed by up to ~12 hours, so items are never presented as
            real-time alerts. Stories are ranked by their original publication timestamps: freshly published
            RSS items outrank older API deliveries, and stale stories (&gt;48h) are rejected automatically.
            When the daily NewsData budget is exhausted, RSS discovery continues unaffected.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            Duplicate reports of the same event across publishers are merged; corroborated stories rank higher
            based on internal evidence only — popularity is never fabricated.
          </p>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 24/7 operation + duplicate shield                                    */
/* ------------------------------------------------------------------ */

const EXPECTED_RUNS_PER_DAY = 180;

function ContinuousCard({ runsToday, lastRun }: { runsToday: number; lastRun: DashboardRun | null }) {
  const elapsedMinutes = Math.floor((Date.now() - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 60000);
  const expectedSoFar = Math.max(1, Math.floor(elapsedMinutes / 8));
  const coverage = Math.min(100, Math.round((runsToday / expectedSoFar) * 100));
  const minutesSinceLast = lastRun ? Math.floor((Date.now() - Date.parse(lastRun.startedAt)) / 60000) : null;
  const healthy = minutesSinceLast !== null && minutesSinceLast <= 20;

  return (
    <Card className="lg:col-span-2">
      <SectionLabel icon={<InfinityIcon className="h-3.5 w-3.5" />}>Continuous operation</SectionLabel>
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        DynaSport runs 24/7 — every 8 minutes, all day, every day. There is no operating window, overnight
        pause, weekend pause or holiday pause, and no browser or manual start is required.
      </p>
      <dl className="mt-4 space-y-2 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Runs today</dt>
          <dd className="font-mono tabular-nums text-zinc-200">
            {formatInteger(runsToday)} / ~{expectedSoFar} expected
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Daily target</dt>
          <dd className="font-mono tabular-nums text-zinc-300">{EXPECTED_RUNS_PER_DAY} runs / 24h</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Last run</dt>
          <dd className={`font-mono tabular-nums ${healthy ? "text-emerald-300/90" : "text-amber-300/90"}`}>
            {lastRun ? timeAgo(lastRun.startedAt) : "none yet"}
          </dd>
        </div>
      </dl>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className={`h-full rounded-full ${coverage >= 80 ? "bg-lime-300" : "bg-amber-300"}`}
          style={{ width: `${Math.max(coverage, runsToday > 0 ? 3 : 0)}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        {coverage}% schedule coverage so far today. Transient failures recover automatically on the next run.
      </p>
    </Card>
  );
}

function DuplicateShieldCard({ totals }: { totals: DashboardData["totals"] }) {
  const layers = [
    {
      label: "A · Exact article",
      detail: "Provider IDs, canonical URLs and content fingerprints — unique constraint in Neon",
      value: totals.exactDuplicates,
    },
    {
      label: "B · Same story",
      detail: "Entity + event fingerprints and headline similarity across publishers",
      value: totals.storyDuplicates,
    },
    {
      label: "C · Publication claim",
      detail: "Primary key on (story, stage) — concurrent runs cannot post one story twice",
      value: totals.publishedTotal,
    },
    {
      label: "D · Follow-ups only",
      detail: "Re-posts allowed only for a bid, agreement or official confirmation",
      value: totals.followups,
    },
  ];

  return (
    <Card className="lg:col-span-3">
      <SectionLabel icon={<ShieldCheck className="h-3.5 w-3.5" />}>Duplicate protection</SectionLabel>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        One underlying story produces at most one normal Facebook post, across every provider, feed,
        publisher, manual run and scheduled run.
      </p>
      <ul className="mt-3 space-y-2">
        {layers.map((layer) => (
          <li
            key={layer.label}
            className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200">{layer.label}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{layer.detail}</p>
            </div>
            <span className="shrink-0 font-mono text-sm tabular-nums text-zinc-300">
              {formatInteger(layer.value)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-zinc-600">
        Stale items ({formatInteger(totals.rejectedStale)}) are rejected rather than published as breaking
        news, and {formatInteger(totals.awaitingRetry)} failed post(s) remain queued for retry.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

function EmptyState({ text }: { text: string }) {
  return (
    <div className="mt-6 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.015] px-4 py-8 text-center">
      <p className="mx-auto max-w-sm text-xs leading-relaxed text-zinc-500">{text}</p>
    </div>
  );
}

function OfflineState() {
  return (
    <Card className="mt-8">
      <SectionLabel icon={<Database className="h-3.5 w-3.5" />}>Database connection pending</SectionLabel>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-400">
        Dynamic data appears as soon as the Neon PostgreSQL database is reachable. Provision a Neon project,
        then set the environment variables below and redeploy — the schema is created automatically on first
        run and cron-job.org can start calling the automation endpoint.
      </p>
      <ul className="mt-5 grid gap-2 font-mono text-xs text-zinc-400 sm:grid-cols-2">
        {[
          "DATABASE_URL",
          "NEWSDATA_API_KEY",
          "FACEBOOK_PAGE_ID",
          "FACEBOOK_PAGE_ACCESS_TOKEN",
          "FACEBOOK_APP_ID",
          "FACEBOOK_APP_SECRET",
          "CRON_SECRET",
        ].map((name) => (
          <li key={name} className="rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
            {name}
          </li>
        ))}
      </ul>
    </Card>
  );
}
