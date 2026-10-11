import { timingSafeEqual } from "node:crypto";
import { runAutomation } from "@/lib/automation";

/**
 * Production DynaSport automation endpoint.
 *
 * Contract with cron-job.org (unchanged):
 *   - URL: /api/football/automation
 *   - Schedule: every 10 minutes
 *   - Auth: "Authorization: Bearer <CRON_SECRET>" header
 *
 * Manual runs and cron retries use this exact same endpoint, so every
 * execution path shares the same Neon-backed flood control and claims
 * and the same duplicate protection. There is no query-string secret and
 * no unauthenticated trigger anywhere in the application.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  try {
    const summary = await runAutomation("scheduled");
    const status = summary.status === "error" ? 500 : 200;
    return Response.json({ ok: summary.status !== "error", ...summary }, { status });
  } catch (error) {
    return Response.json(
      { ok: false, error: safeMessage(error) },
      { status: 500 },
    );
  }
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length === 0) {
    // Fail closed: without CRON_SECRET no one may trigger automation.
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }

  const presented = header.slice("Bearer ".length).trim();
  return timingSafeStringEqual(presented, secret.trim());
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const secret = process.env.CRON_SECRET;
  return secret ? message.split(secret).join("[redacted]") : message;
}
