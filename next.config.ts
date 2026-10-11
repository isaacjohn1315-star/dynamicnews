import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `pg` is a native Node database driver (it uses net/tls/dns and has an
   * optional `pg-native` dependency). Letting the bundler inline it into a
   * serverless function is a known cause of deployment and runtime failures
   * on Vercel, so it is kept external and required from node_modules at
   * runtime instead.
   *
   * It is only ever imported when DATABASE_URL is NOT a Neon endpoint
   * (local development); production on Neon uses the pure-HTTP Neon
   * serverless driver and never loads pg at all.
   */
  serverExternalPackages: ["pg"],
};

export default nextConfig;
