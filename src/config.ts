import { config as loadEnv } from "dotenv";

loadEnv();

/** The hosted registry. Contributors point at this unless they self-host. */
const DEFAULT_REGISTRY_URL = "https://tendrilregister.007575.xyz";

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
  // Where the registry lives. A contributor does not normally set this — the
  // default is the hosted Tendril backend; override only when self-hosting.
  registryUrl: normalizeRegistryUrl(process.env.REGISTRY_URL ?? DEFAULT_REGISTRY_URL),
  /**
   * The only credential a contributor holds. Minted in the web UI by a signed-in
   * wallet, it identifies the node AND names the address earnings go to — which
   * is why there is no private key or payout address here.
   */
  apiKey: process.env.TENDRIL_API_KEY ?? "",
  label: process.env.NODE_LABEL ?? "tendril-node",
  // Advertised price per HOUR (USD) — industry-standard hourly billing.
  pricePerHourUsd: Number(process.env.PRICE_PER_HOUR_USD ?? 1.0),
  sandbox: {
    // SSH sandbox image (built locally on first run if missing). The renter gets
    // a plain SSH shell, not a Jupyter server.
    image: process.env.SANDBOX_IMAGE ?? "tendril-ssh-sandbox:latest",
    memory: process.env.SANDBOX_MEMORY ?? "2g",
    cpus: Number(process.env.SANDBOX_CPUS ?? 2),
    gpus: process.env.SANDBOX_GPUS ?? "", // "all" to pass GPUs through
    // Reverse tunnel the sandbox dials out to, to expose SSH publicly. NOT from
    // the environment: the registry sends these in the hello ack, so the
    // platform can move every node to a different bore server at once.
    boreServer: "bore.pub",
    boreSecret: "",
  },
  // "bore" exposes SSH publicly via an in-container bore tunnel; "local" publishes
  // SSH to loopback (handy when consumer + agent run on the same machine).
  tunnelMode: (process.env.TUNNEL_MODE ?? "bore") as "bore" | "local",
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 10_000),
};
