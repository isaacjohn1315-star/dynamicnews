/**
 * Centralized, server-only access to DynaSport environment configuration.
 *
 * Required variables (see .env.example):
 *   DATABASE_URL                 Neon PostgreSQL connection string
 *   NEWSDATA_API_KEY             NewsData.io API key
 *   FACEBOOK_PAGE_ID             DynaSport Facebook Page ID
 *   FACEBOOK_PAGE_ACCESS_TOKEN   Facebook Page access token
 *   FACEBOOK_APP_ID              Meta app ID (token debug flow only)
 *   FACEBOOK_APP_SECRET          Meta app secret (token debug flow only)
 *   CRON_SECRET                  Bearer secret for the automation endpoint
 *
 * Values are read lazily at call time so builds never bake secrets into
 * bundles and missing configuration fails with a clear, key-free message.
 */

function optional(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

export function newsdataApiKey(): string | null {
  return optional("NEWSDATA_API_KEY");
}

export function facebookPageId(): string {
  return required("FACEBOOK_PAGE_ID");
}

export function facebookPageAccessToken(): string {
  return required("FACEBOOK_PAGE_ACCESS_TOKEN");
}

export function cronSecret(): string | null {
  return optional("CRON_SECRET");
}

/**
 * Meta app credentials are only used by the official /debug_token flow,
 * which requires an app access token in the form "{app-id}|{app-secret}".
 * They are never used to alter or refresh the existing Page token.
 */
export function facebookAppCredentials(): { appId: string; appSecret: string } | null {
  const appId = optional("FACEBOOK_APP_ID");
  const appSecret = optional("FACEBOOK_APP_SECRET");
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/** Presence-only configuration summary. Never exposes secret values. */
export function configPresence(): {
  database: boolean;
  newsdata: boolean;
  facebookPage: boolean;
  facebookApp: boolean;
  cronSecret: boolean;
} {
  return {
    database: optional("DATABASE_URL") !== null,
    newsdata: optional("NEWSDATA_API_KEY") !== null,
    facebookPage: optional("FACEBOOK_PAGE_ID") !== null && optional("FACEBOOK_PAGE_ACCESS_TOKEN") !== null,
    facebookApp: optional("FACEBOOK_APP_ID") !== null && optional("FACEBOOK_APP_SECRET") !== null,
    cronSecret: optional("CRON_SECRET") !== null,
  };
}
