import { getDb } from "@/lib/db";

/**
 * Liveness + readiness probe.
 * Always answers 200 so process monitors see the service state; the body
 * reports whether the Neon database is configured and reachable.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const databaseConfigured =
    typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0;

  let database: "up" | "unavailable" | "not_configured" = "not_configured";
  if (databaseConfigured) {
    try {
      const sql = getDb();
      await sql`SELECT 1`;
      database = "up";
    } catch {
      database = "unavailable";
    }
  }

  return Response.json({
    ok: true,
    service: "dynasport",
    time: new Date().toISOString(),
    database: {
      driver: "neon",
      configured: databaseConfigured,
      status: database,
    },
  });
}
