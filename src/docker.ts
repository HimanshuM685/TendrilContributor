import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JOB_RESULT_MAX_BYTES, boundedRunTimeoutMs, RUN_MAX_TIMEOUT_MS, type SandboxLimits } from "./protocol.js";
import { config } from "./config.js";

const execFileP = promisify(execFile);

const WARM_EXEC_POOL_LIMIT = 2;
const WARM_EXEC_LIFETIME_MS = RUN_MAX_TIMEOUT_MS + 300_000;
const DEPENDENCY_PROBE =
  "import nbclient, nbformat, ipykernel, numpy, pandas, matplotlib, requests, scipy, sklearn, PIL, psutil";

/** The renter's uid inside every sandbox (created in sandbox-ssh/Dockerfile). */
export const SANDBOX_USER = "tendril";
const SANDBOX_UID = "1000";
/** Private bridge for sandboxes: inter-container traffic is disabled on it. */
const SANDBOX_NETWORK = "tendril-sandbox";
/** Every container we start carries this label, so a restart can sweep leftovers. */
const LEASE_LABEL = "tendril.lease";

type ExecProfile = {
  image: string;
  memory: string;
  cpus: string;
  gpus: string;
};

type WarmExec = ExecProfile & { name: string; createdAt: number };

const warmExecs: WarmExec[] = [];
const leaseContainers = new Map<string, string>();

function dockerLog(event: string, fields: Record<string, unknown> = {}): void {
  console.log(`[docker] ${JSON.stringify({ event, ...fields })}`);
}

function dockerFailure(event: string, startedAt: number, err: unknown, fields: Record<string, unknown> = {}): void {
  dockerLog(event, {
    ...fields,
    ok: false,
    elapsedMs: Date.now() - startedAt,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** The endpoint a renter SSHes into, once the sandbox is up. */
export interface SandboxEndpoint {
  leaseId: string;
  containerName: string;
  host: string;
  port: number;
}

function containerName(leaseId: string): string {
  return `tendril-${leaseId.replace(/[^a-zA-Z0-9_.-]/g, "")}`;
}

function guardName(sandbox: string): string {
  return `${sandbox}-guard`;
}

/** Ask the OS for an available TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate port")));
      }
    });
    srv.on("error", reject);
  });
}

/** Number of CPUs the Docker daemon exposes — `docker run --cpus` can't exceed
 *  it. Cached after the first lookup; 0 means "couldn't determine" (skip clamp). */
let ncpuCache: number | null = null;
async function dockerNcpu(): Promise<number> {
  if (ncpuCache !== null) return ncpuCache;
  try {
    const { stdout } = await execFileP("docker", ["info", "--format", "{{.NCPU}}"]);
    const n = parseInt(stdout.trim(), 10);
    ncpuCache = Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    ncpuCache = 0;
  }
  return ncpuCache;
}

// ---------------------------------------------------------------------------
// Policy: what this machine agrees to run, and how much of itself it lends.
// Pure functions so they are unit-testable without a daemon.
// ---------------------------------------------------------------------------

/** Docker memory string ("2g", "512m", "1024k", "2GiB") to bytes. Throws on junk. */
export function parseMemory(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?(?:i?b)?\s*$/i.exec(raw);
  if (!m) throw new Error(`invalid memory size: ${JSON.stringify(raw)}`);
  const unit = (m[2] ?? "b").toLowerCase();
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit] ?? 1;
  return Math.floor(Number(m[1]) * scale);
}

/**
 * The registry's request clamped to the operator's ceilings (SANDBOX_MEMORY,
 * SANDBOX_CPUS, SANDBOX_GPUS) and to what the daemon physically has. The
 * registry is trusted to schedule, not to decide how much of someone's laptop
 * is for rent.
 */
export function effectiveLimits(
  requested: Partial<SandboxLimits>,
  ncpu: number,
  ceilings = config.sandbox,
): SandboxLimits {
  const memory = requested.memory && parseMemory(requested.memory) < parseMemory(ceilings.memory)
    ? requested.memory
    : ceilings.memory;
  let cpus = Math.min(Number(requested.cpus || ceilings.cpus), ceilings.cpus);
  if (ncpu > 0 && cpus > ncpu) cpus = ncpu;
  cpus = Math.max(cpus, 0.1);
  const gpus = ceilings.gpus && requested.gpus ? ceilings.gpus : "";
  return { memory, cpus, gpus };
}

/** Image references we will ever hand to `docker run`. */
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/**
 * Only the image the operator configured (or explicitly allow-listed) is run.
 * The registry names an image per lease; a compromised or impersonated
 * registry must not be able to make every contributor pull and run an
 * arbitrary image. The shape check also guarantees the reference can never be
 * parsed as a `docker run` flag.
 */
export function imageAllowed(image: string, policy = config.sandbox): boolean {
  if (!IMAGE_REF.test(image)) return false;
  return image === policy.image || policy.allowedImages.includes(image);
}

function assertImageAllowed(image: string): void {
  if (!imageAllowed(image)) {
    throw new Error(
      `image ${JSON.stringify(image)} is not permitted on this contributor (set SANDBOX_IMAGE or SANDBOX_ALLOWED_IMAGES)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Host preparation: daemon posture, private network, leftovers from a crash.
// ---------------------------------------------------------------------------

/**
 * Log the daemon's security posture once at boot. We never rely on a daemon
 * default silently: a missing seccomp profile is called out loudly, because
 * the per-container flags below assume Docker's default syscall filter.
 */
export async function dockerPreflight(): Promise<void> {
  const { stdout } = await execFileP("docker", [
    "info",
    "--format",
    "{{json .SecurityOptions}} {{.ServerVersion}} {{.OperatingSystem}}",
  ]);
  const [json, ...rest] = stdout.trim().split(" ");
  const opts: string[] = JSON.parse(json || "[]");
  const has = (name: string) => opts.some((o) => o === `name=${name}` || o.startsWith(`name=${name},`));
  dockerLog("preflight", {
    server: rest.join(" "),
    seccomp: has("seccomp"),
    apparmor: has("apparmor"),
    userns: has("userns"),
    rootless: has("rootless"),
    netGuard: config.sandbox.netGuard,
  });
  if (!has("seccomp")) {
    console.warn("[docker] WARNING: daemon reports no seccomp profile; sandboxes run with an unfiltered syscall surface");
  }
  if (config.sandbox.netGuard === "off") {
    console.warn("[docker] WARNING: SANDBOX_NET_GUARD=off — renters can reach this host and its LAN from inside sandboxes");
  }
}

/** Private bridge with inter-container communication disabled, created once. */
export async function ensureSandboxNetwork(): Promise<void> {
  try {
    await execFileP("docker", ["network", "inspect", SANDBOX_NETWORK]);
    return;
  } catch {
    /* absent */
  }
  await execFileP("docker", [
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    SANDBOX_NETWORK,
  ]);
  dockerLog("network.created", { network: SANDBOX_NETWORK });
}

/** Remove sandboxes and guards left behind by a previous agent process. */
export async function sweepOrphans(): Promise<void> {
  const { stdout } = await execFileP("docker", ["ps", "-aq", "--filter", `label=${LEASE_LABEL}`]);
  const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return;
  await execFileP("docker", ["rm", "-f", ...ids]);
  dockerLog("orphans.removed", { count: ids.length });
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

/** Build context for the bundled sandbox image. */
const SANDBOX_CTX = resolve(dirname(fileURLToPath(import.meta.url)), "../sandbox-ssh");

/**
 * Fingerprint of the files that decide how the sandbox behaves.
 *
 * The image is cached on the host forever, so tagging it `:latest` and only
 * building when it is *absent* means an edit to `entrypoint.sh` is never picked
 * up — the contributor keeps starting containers built from the old script, and
 * the symptom is remote and baffling (SSH auth silently behaving like an older
 * build). Folding the content hash into the tag makes a changed entrypoint a
 * different image, so it rebuilds exactly when it should and not otherwise.
 */
function sandboxTag(): string | null {
  const dockerfile = join(SANDBOX_CTX, "Dockerfile");
  const entrypoint = join(SANDBOX_CTX, "entrypoint.sh");
  if (!existsSync(dockerfile)) return null;
  const h = createHash("sha256");
  for (const f of [dockerfile, entrypoint]) {
    if (existsSync(f)) h.update(readFileSync(f));
  }
  return `tendril-ssh-sandbox:${h.digest("hex").slice(0, 12)}`;
}

/**
 * Resolve the image to run, building it if needed. Returns the tag actually
 * used, which may differ from `image` when we substitute a content-tagged build
 * of the bundled sandbox. Refuses anything outside the operator's allow-list
 * before touching the daemon, so an unknown name is never pulled.
 */
export async function ensureImage(image: string): Promise<string> {
  const startedAt = Date.now();
  assertImageAllowed(image);
  // An explicitly configured SANDBOX_IMAGE is the operator's to manage: we only
  // check it exists and never rebuild it from our context.
  const bundled = image === config.sandbox.image && existsSync(join(SANDBOX_CTX, "Dockerfile"));
  const tag = bundled ? (sandboxTag() ?? image) : image;

  try {
    await execFileP("docker", ["image", "inspect", tag]);
    dockerLog("image.reused", { image: tag, elapsedMs: Date.now() - startedAt });
    return tag;
  } catch {
    /* not present */
  }
  if (!bundled) {
    throw new Error(`image ${JSON.stringify(tag)} is not present locally; pull or build it first`);
  }

  console.log(`[docker] building sandbox image ${tag} (streamed context)…`);
  // The contributor may run in a container while Docker uses the host daemon.
  // A path build would ask that daemon for /app/contributor/sandbox-ssh, which
  // does not exist on the host. Stream the local context through stdin instead.
  try {
    await execFileP(
      "sh",
      ["-c", "tar -C \"$1\" -czf - . | docker build -t \"$2\" -", "tendril-build", SANDBOX_CTX, tag],
      { maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err) {
    dockerFailure("image.failed", startedAt, err, { image: tag });
    throw err;
  }
  dockerLog("image.ready", { image: tag, elapsedMs: Date.now() - startedAt });
  return tag;
}

// ---------------------------------------------------------------------------
// Container arguments. ONE place decides what a sandbox may do.
// ---------------------------------------------------------------------------

function execProfile(image: string, memory: string, cpus: number, gpus: string): ExecProfile {
  return { image, memory, cpus: String(cpus), gpus };
}

function sameProfile(a: ExecProfile, b: ExecProfile): boolean {
  return a.image === b.image && a.memory === b.memory && a.cpus === b.cpus && a.gpus === b.gpus;
}

/**
 * The hardening every sandbox gets, SSH and exec alike. This IS the safety
 * model; read it as the threat model's answer:
 *   --user 1000           the renter is never root, even inside the container
 *   --cap-drop ALL        no capabilities, no add-backs (sshd runs unprivileged)
 *   no-new-privileges     setuid binaries cannot raise privileges
 *   --read-only           the image is immutable; nothing persists
 *   --tmpfs /work,/tmp    the only writable space, RAM-backed (counts against
 *                         --memory) and size-capped
 *   --memory/--cpus/--pids-limit/--ulimit fsize   cgroup + rlimit ceilings
 *   --network tendril-sandbox   private bridge, inter-container traffic off;
 *                         the guard sidecar then fences off the host and LAN
 *   --log-driver local    bounded container logs (stdout spam can't fill disk)
 *   no -v, no secrets     nothing of the host, and no BORE_SECRET, is inside
 */
function hardenedRunArgs(name: string, leaseId: string, profile: ExecProfile): string[] {
  // tmpfs pages are charged to the container's memory cgroup, so scratch can
  // never honestly be larger than the memory limit: a renter who fills /work
  // past it has their writer OOM-killed, not the host's disk filled.
  const disk = Math.min(parseMemory(config.sandbox.disk), parseMemory(profile.memory));
  const threads = String(Math.max(1, Math.ceil(Number(profile.cpus))));
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `${LEASE_LABEL}=${leaseId}`,
    "--network",
    SANDBOX_NETWORK,
    "--user",
    `${SANDBOX_UID}:${SANDBOX_UID}`,
    "--group-add",
    "tty",
    "--memory",
    profile.memory,
    "--memory-swap",
    profile.memory,
    "--cpus",
    profile.cpus,
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    "--read-only",
    "--tmpfs",
    `/work:rw,nosuid,nodev,size=${disk},mode=0700,uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--ulimit",
    `fsize=${disk}:${disk}`,
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=2",
    "-e",
    "HOME=/work",
    "-e",
    "PYTHONDONTWRITEBYTECODE=1",
    "-e",
    "PIP_NO_CACHE_DIR=1",
    "-e",
    "MPLBACKEND=Agg",
    "-e",
    `OMP_NUM_THREADS=${threads}`,
    "-e",
    `OPENBLAS_NUM_THREADS=${threads}`,
    ...(profile.gpus ? ["--gpus", profile.gpus] : []),
  ];
}

function execRunArgs(profile: ExecProfile, name: string, leaseId: string, lifetimeMs = WARM_EXEC_LIFETIME_MS): string[] {
  return [
    ...hardenedRunArgs(name, leaseId, profile),
    "--entrypoint",
    "sleep",
    profile.image,
    String(Math.ceil(Math.min(RUN_MAX_TIMEOUT_MS + 300_000, lifetimeMs) / 1000)),
  ];
}

/**
 * The guard is the privileged half of a lease: root with CAP_NET_ADMIN (plus
 * SETUID/SETGID, used once to drop to uid 1000), sharing only the sandbox's
 * network namespace. It installs the
 * netfilter rules (which then belong to the namespace, beyond the sandbox's
 * reach) and, in bore mode, runs the tunnel client as uid 1000 with no
 * capabilities. BORE_SECRET lives here and only here. Always the bundled
 * image: a custom SANDBOX_IMAGE need not ship iptables.
 */
function guardRunArgs(sandbox: string, leaseId: string, image: string, mode: "bore" | "oneshot"): string[] {
  const bore = mode === "bore";
  return [
    "run",
    ...(bore ? ["-d"] : ["--rm"]),
    "--name",
    guardName(sandbox),
    "--label",
    `${LEASE_LABEL}=${leaseId}`,
    "--network",
    `container:${sandbox}`,
    "--cap-drop",
    "ALL",
    // NET_ADMIN for the rules; SETUID/SETGID only so the entrypoint can shed
    // root before exec'ing bore. All three are gone by the time bore runs.
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=16m",
    "--pids-limit",
    "32",
    "--memory",
    "64m",
    "--memory-swap",
    "64m",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=5m",
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
    "-e",
    `SANDBOX_NET_GUARD=${config.sandbox.netGuard}`,
    ...(bore
      ? [
        "-e",
        `BORE_SERVER=${config.sandbox.boreServer}`,
        ...(config.sandbox.boreSecret ? ["-e", `BORE_SECRET=${config.sandbox.boreSecret}`] : []),
      ]
      : ["-e", "NO_BORE=1"]),
    "--entrypoint",
    "/entrypoint.sh",
    image,
    "guard",
  ];
}

/**
 * Fence the sandbox's network namespace. Resolves once the rules are in
 * (one-shot) or once the guard is detached (bore). Fails closed: a guard that
 * cannot install its rules exits non-zero and the caller tears the sandbox
 * down.
 */
async function startGuard(sandbox: string, leaseId: string, mode: "bore" | "oneshot"): Promise<void> {
  const startedAt = Date.now();
  const image = await ensureImage(config.sandbox.image);
  try {
    await execFileP("docker", guardRunArgs(sandbox, leaseId, image, mode), { timeout: 60_000, maxBuffer: 1024 * 1024 });
    dockerLog("guard.ready", { container: guardName(sandbox), mode, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    dockerFailure("guard.failed", startedAt, err, { container: guardName(sandbox), mode });
    throw new Error(`network guard failed: ${(err as Error).message}`);
  }
}

function probeArgs(): string[] {
  const probe = JSON.stringify(DEPENDENCY_PROBE);
  return [
    "sh",
    "-c",
    `if [ -x /work/.venv/bin/python ]; then exec /work/.venv/bin/python -c ${probe}; else exec python3 -c ${probe}; fi`,
  ];
}

async function prepareExecContainer(name: string, startedAt = Date.now()): Promise<void> {
  await execFileP(
    "docker",
    ["exec", name, "python3", "-m", "venv", "--system-site-packages", "/work/.venv"],
    { timeout: 30_000 },
  );
  const probe = await execFileP("docker", ["exec", name, ...probeArgs()], { timeout: 30_000 });
  dockerLog("sandbox.dependencies_ready", {
    container: name,
    elapsedMs: Date.now() - startedAt,
    probe: probe.stdout.trim().split("\n").at(-1) || "ok",
  });
}

function takeWarmExec(profile: ExecProfile): WarmExec | undefined {
  const index = warmExecs.findIndex((entry) => sameProfile(entry, profile));
  if (index < 0) return undefined;
  return warmExecs.splice(index, 1)[0];
}

/** Remove a sandbox and its guard (idempotent; either may already be gone). */
async function removeContainer(name: string): Promise<void> {
  try {
    await execFileP("docker", ["rm", "-f", name, guardName(name)]);
  } catch {
    /* one or both already gone */
  }
}

/** Fill a small pool of pristine exec containers; only exact resource matches are reused. */
export async function warmExecPool(
  imageOverride: string,
  limits: Pick<SandboxLimits, "memory" | "cpus" | "gpus">,
): Promise<void> {
  const startedAt = Date.now();
  const image = await ensureImage(imageOverride || config.sandbox.image);
  const eff = effectiveLimits(limits, await dockerNcpu());
  const profile = execProfile(image, eff.memory, eff.cpus, eff.gpus);
  const needed = Math.max(0, WARM_EXEC_POOL_LIMIT - warmExecs.length);
  for (let i = 0; i < needed; i++) {
    const name = `tendril-warm-${randomUUID()}`;
    const itemStartedAt = Date.now();
    try {
      await execFileP("docker", execRunArgs(profile, name, "warm"), { maxBuffer: 10 * 1024 * 1024 });
      await startGuard(name, "warm", "oneshot");
      await prepareExecContainer(name, itemStartedAt);
      warmExecs.push({ ...profile, name, createdAt: Date.now() });
      dockerLog("sandbox.warm_ready", {
        container: name,
        poolSize: warmExecs.length,
        elapsedMs: Date.now() - itemStartedAt,
      });
    } catch (err) {
      dockerFailure("sandbox.warm_failed", itemStartedAt, err, { container: name });
      await removeContainer(name);
    }
  }
  dockerLog("sandbox.warm_complete", {
    poolSize: warmExecs.length,
    requested: WARM_EXEC_POOL_LIMIT,
    elapsedMs: Date.now() - startedAt,
  });
}

export async function stopWarmExecPool(): Promise<void> {
  const pending = warmExecs.splice(0).map(({ name }) => removeContainer(name));
  await Promise.all(pending);
  if (pending.length) dockerLog("sandbox.warm_stopped", { count: pending.length });
}

/**
 * Start a hardened, ephemeral sandbox (see `hardenedRunArgs` for the model).
 * SSH sandboxes are public-key only and log in as the unprivileged
 * `tendril` user. In bore mode no host port is published: the guard sidecar
 * dials OUT to the bore server. In local mode (same machine) port 22 is
 * published to loopback instead.
 */
export async function startSandbox(
  leaseId: string,
  imageOverride: string,
  limits: SandboxLimits,
  _sshPassword: string | null,
  sshPubKey: string | null,
  surface: "ssh" | "exec" = "ssh",
  lifetimeMs = RUN_MAX_TIMEOUT_MS + 300_000,
): Promise<SandboxEndpoint> {
  const startedAt = Date.now();
  const image = imageOverride || config.sandbox.image;
  const runImage = await ensureImage(image);
  const name = containerName(leaseId);
  const requestedCpus = Number(limits.cpus || config.sandbox.cpus);
  const eff = effectiveLimits(limits, await dockerNcpu());
  if (eff.cpus < requestedCpus) {
    console.warn(`[docker] requested ${requestedCpus} CPUs; clamped to ${eff.cpus}`);
  }
  const local = config.tunnelMode === "local";
  const execOnly = surface === "exec";
  const profile = execProfile(runImage, eff.memory, eff.cpus, eff.gpus);

  if (!execOnly && !sshPubKey) {
    throw new Error("ssh sandbox requires a public key; password login is not supported");
  }

  if (execOnly) {
    const warm = takeWarmExec(profile);
    if (warm) {
      try {
        const requestedLifetime = Math.min(WARM_EXEC_LIFETIME_MS, lifetimeMs);
        if (Date.now() - warm.createdAt + requestedLifetime > WARM_EXEC_LIFETIME_MS) {
          throw new Error("warm sandbox lifetime would exceed its safety cap");
        }
        await execFileP("docker", ["inspect", warm.name], { timeout: 10_000 });
        await execFileP("docker", ["exec", warm.name, ...probeArgs()], { timeout: 30_000 });
        leaseContainers.set(leaseId, warm.name);
        dockerLog("sandbox.reused", {
          leaseId,
          container: warm.name,
          warmAgeMs: Date.now() - warm.createdAt,
          elapsedMs: Date.now() - startedAt,
        });
        return { leaseId, containerName: warm.name, host: "", port: 0 };
      } catch (err) {
        dockerFailure("sandbox.warm_unusable", startedAt, err, { leaseId, container: warm.name });
        await removeContainer(warm.name);
      }
    }
  }

  let hostPort = 0;
  let args: string[];
  if (execOnly) {
    args = execRunArgs(profile, name, leaseId, lifetimeMs);
  } else {
    args = hardenedRunArgs(name, leaseId, profile);
    // The entrypoint writes this to authorized_keys. The private key is never
    // in this environment; it is the only credential a renter holds.
    args.push("-e", `SSH_PUBKEY=${sshPubKey}`);
    if (local) {
      hostPort = await getFreePort();
      args.push("-p", `127.0.0.1:${hostPort}:22`);
    }
    args.push(runImage, "sandbox");
  }

  console.log(
    `[docker] starting ${execOnly ? "exec" : "SSH"} sandbox ${name} (${runImage})` +
      (execOnly ? "" : local ? ` on 127.0.0.1:${hostPort}` : ` via bore (${config.sandbox.boreServer})`),
  );
  try {
    await execFileP("docker", args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    dockerFailure("sandbox.start_failed", startedAt, err, { leaseId, surface, container: name });
    throw err;
  }
  leaseContainers.set(leaseId, name);

  // Fence the namespace before anything untrusted can run or connect. Fails
  // closed: no rules, no sandbox.
  try {
    await startGuard(name, leaseId, !execOnly && !local ? "bore" : "oneshot");
  } catch (err) {
    await stopSandbox(leaseId);
    throw err;
  }

  if (execOnly) {
    // A venv on bounded writable storage allows %pip without changing the
    // read-only image or the contributor host. The kernel uses this interpreter.
    try {
      await prepareExecContainer(name, startedAt);
      dockerLog("sandbox.ready", { leaseId, surface, container: name, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      dockerFailure("sandbox.prepare_failed", startedAt, err, { leaseId, surface, container: name });
      await stopSandbox(leaseId);
      throw err;
    }
    return { leaseId, containerName: name, host: "", port: 0 };
  }

  try {
    if (local) {
      await waitForPort(hostPort);
      dockerLog("sandbox.ready", { leaseId, surface, container: name, elapsedMs: Date.now() - startedAt });
      return { leaseId, containerName: name, host: "127.0.0.1", port: hostPort };
    }
    const { host, port } = await waitForBoreEndpoint(guardName(name));
    dockerLog("sandbox.ready", { leaseId, surface, container: name, elapsedMs: Date.now() - startedAt });
    return { leaseId, containerName: name, host, port };
  } catch (err) {
    dockerFailure("sandbox.readiness_failed", startedAt, err, { leaseId, surface, container: name });
    await stopSandbox(leaseId);
    throw err;
  }
}

/** Poll a TCP port until it accepts a connection (local-mode readiness). */
async function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const sock = createConnection({ host: "127.0.0.1", port });
      sock.setTimeout(2000);
      sock.on("connect", () => {
        sock.destroy();
        res(true);
      });
      sock.on("error", () => res(false));
      sock.on("timeout", () => {
        sock.destroy();
        res(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("sandbox SSH port did not become reachable in time");
}

const BORE_RE = /listening at ([a-zA-Z0-9.\-]+):(\d+)/i;

/** Tail the guard's logs until bore prints its public endpoint. */
function waitForBoreEndpoint(
  name: string,
  timeoutMs = 60_000,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["logs", "-f", name], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("bore endpoint not announced in time"))),
      timeoutMs,
    );
    const onData = (buf: Buffer) => {
      const m = buf.toString().match(BORE_RE);
      if (m) finish(() => resolve({ host: m[1], port: Number(m[2]) }));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", () =>
      // The guard is not --rm in bore mode, so its last words survive for the error.
      execFileP("docker", ["logs", "--tail", "5", name])
        .then(({ stdout, stderr }) => `${stdout}${stderr}`.trim())
        .catch(() => "")
        .then((tail) => finish(() => reject(new Error(`guard exited before bore came up${tail ? `: ${tail}` : ""}`)))),
    );
  });
}

/** Run a Python script inside the sandbox via `docker exec`, returning output. */
export function runInSandbox(
  leaseId: string,
  payload: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; output: string }> {
  const name = leaseContainers.get(leaseId) ?? containerName(leaseId);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const duration = boundedRunTimeoutMs(timeoutMs);
    // timeout runs INSIDE the container and terminates the process group.
    // Killing only `docker exec` on the host leaves Python descendants alive.
    const child = spawn("docker", ["exec", "-i", name, "timeout", "--signal=TERM", "--kill-after=2s", `${duration / 1000}s`,
      "sh", "-c", "if [ -x /work/.venv/bin/python ]; then exec /work/.venv/bin/python -; else exec python3 -; fi"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    const abort = (message: string) => {
      if (failure) return;
      failure = message;
      child.kill("SIGKILL");
      void stopSandbox(leaseId);
    };
    const timer = setTimeout(() => abort("Job timed out; sandbox stopped."), duration + 3_000);
    const receive = (chunks: Buffer[], data: Buffer) => {
      bytes += data.byteLength;
      if (bytes > JOB_RESULT_MAX_BYTES) abort("Job output exceeded 12 MB; sandbox stopped.");
      else chunks.push(data);
    };
    child.stdout.on("data", (d: Buffer) => receive(out, d));
    child.stderr.on("data", (d: Buffer) => receive(err, d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString();
      const stderr = Buffer.concat(err).toString();
      const timedOut = code === 124 || code === 137;
      if (timedOut) void stopSandbox(leaseId);
      dockerLog("job.complete", {
        leaseId,
        ok: !failure && code === 0,
        exitCode: code,
        timedOut,
        bytes,
        elapsedMs: Date.now() - startedAt,
      });
      resolve({ ok: !failure && code === 0, output: failure || (timedOut ? "Job timed out; sandbox stopped." : code === 0 ? stdout : `${stdout}\n${stderr}`.trim()) });
    });
    child.stdin.on("error", () => { /* process exited before consuming payload */ });
    child.on("error", (e) => {
      clearTimeout(timer);
      dockerFailure("job.failed", startedAt, e, { leaseId, bytes });
      resolve({ ok: false, output: String(e) });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** Forcibly remove the sandbox container and its guard (idempotent). */
export async function stopSandbox(leaseId: string): Promise<void> {
  const name = leaseContainers.get(leaseId) ?? containerName(leaseId);
  leaseContainers.delete(leaseId);
  const startedAt = Date.now();
  await removeContainer(name);
  dockerLog("sandbox.stopped", { leaseId, container: name, elapsedMs: Date.now() - startedAt });
}
