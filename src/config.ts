import { config as loadEnv } from "dotenv";

loadEnv();

/**
 * Normalize REGISTRY_URL: tolerate a bare host (`example.com`) by defaulting to
 * http://, strip any trailing slash, and fail early with a clear message if it's
 * still not a valid URL — instead of a cryptic ERR_INVALID_URL at first fetch.
 */
function normalizeRegistryUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  try {
    new URL(url);
  } catch {
    throw new Error(`invalid REGISTRY_URL: ${JSON.stringify(raw)} (expected e.g. http://host:4000)`);
  }
  return url;
}

export const config = {
  registryUrl: normalizeRegistryUrl(process.env.REGISTRY_URL ?? "http://localhost:4000"),
  privateKeyB64: process.env.AVM_PRIVATE_KEY ?? "",
  label: process.env.NODE_LABEL ?? "tendril-node",
  // Advertised price per HOUR (USD) — industry-standard hourly billing.
  pricePerHourUsd: Number(process.env.PRICE_PER_HOUR_USD ?? 1.0),
  payToAddr: process.env.PAYTO_ADDR ?? "", // defaults to the signing address
  sandbox: {
    // SSH sandbox image (built locally on first run if missing). The renter gets
    // a plain SSH shell, not a Jupyter server.
    image: process.env.SANDBOX_IMAGE ?? "tendril-ssh-sandbox:latest",
    memory: process.env.SANDBOX_MEMORY ?? "2g",
    cpus: Number(process.env.SANDBOX_CPUS ?? 2),
    gpus: process.env.SANDBOX_GPUS ?? "", // "all" to pass GPUs through
    // bore server the sandbox dials out to, to expose SSH publicly.
    boreServer: process.env.BORE_SERVER ?? "bore.pub",
    // Optional shared secret for a self-hosted bore server (bore reads it from
    // the BORE_SECRET env var). Leave empty for the public bore.pub.
    boreSecret: process.env.BORE_SECRET ?? "",
  },
  // "bore" exposes SSH publicly via an in-container bore tunnel; "local" publishes
  // SSH to loopback (handy when consumer + agent run on the same machine).
  tunnelMode: (process.env.TUNNEL_MODE ?? "bore") as "bore" | "local",
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 10_000),
};
