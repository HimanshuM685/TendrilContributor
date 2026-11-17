import { io, type Socket } from "socket.io-client";
import {
  WS,
  type AgentHelloMsg,
  type ContainerFailedMsg,
  type ContainerReadyMsg,
  type DestroyContainerMsg,
  type HeartbeatMsg,
  type HelloAckMsg,
  type JobResultMsg,
  type RunJobMsg,
  type StartContainerMsg,
} from "./protocol.js";
import { config } from "./config.js";
import { detectSpecs } from "./specs.js";
import {
  SANDBOX_USER,
  dockerPreflight,
  ensureImage,
  ensureSandboxNetwork,
  runInSandbox,
  startSandbox,
  stopSandbox,
  stopWarmExecPool,
  sweepOrphans,
  warmExecPool,
} from "./docker.js";

if (!config.apiKey) {
  console.error(
    "TENDRIL_API_KEY is required. Sign in at the Tendril web app, open Contribute, and mint one.",
  );
  process.exit(1);
}

/** Lease ids of sandboxes this agent is currently hosting. */
const activeLeases = new Set<string>();
let nodeId: string | undefined;

async function main() {
  // Host first: daemon posture, leftovers from a crashed agent, the private
  // sandbox network. Then build the bundled sandbox before registering, so a
  // first paid lease does not spend its registry timeout on an image build.
  await dockerPreflight();
  await sweepOrphans();
  await ensureSandboxNetwork();
  await ensureImage(config.sandbox.image);
  const detected = await detectSpecs();
  // GPUs are rented out only when the operator opted in with SANDBOX_GPUS, so
  // what we advertise is exactly what a sandbox will get.
  const specs = { ...detected, gpu: config.sandbox.gpus ? detected.gpu : null };
  // Keep only a couple of pristine, exact-profile exec containers ready. SSH
  // containers never enter this pool, and a failed warm-up does not block
  // registration; the first lease falls back to the normal cold path.
  await warmExecPool(config.sandbox.image, {
    cpus: Math.min(specs.cpuCores, 4),
    memory: config.sandbox.memory,
    gpus: specs.gpu ? "all" : "",
  }).catch((err) => console.error(`[agent] exec warm pool failed: ${(err as Error).message}`));
  console.log(`[agent] registry: ${config.registryUrl}`);
  console.log(`[agent] specs: ${specs.cpuCores} CPU, ${specs.ramMb}MB RAM, GPU=${specs.gpu ?? "none"}`);
  console.log(`[agent] price: $${config.pricePerHourUsd}/hr`);

  const socket = io(config.registryUrl, { transports: ["websocket"] });
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  socket.on("connect", () => {
    const hello: AgentHelloMsg = {
      apiKey: config.apiKey,
      spec: {
        label: config.label,
        cpuCores: specs.cpuCores,
        ramMb: specs.ramMb,
        gpu: specs.gpu,
        pricePerHourUsd: config.pricePerHourUsd,
      },
    };
    socket.emit(WS.hello, hello);
  });

  socket.on(WS.helloAck, (ack: HelloAckMsg) => {
    nodeId = ack.nodeId;
    // The registry owns the tunnel settings, so a sandbox started after this
    // point uses whatever it just told us — nothing to configure locally.
    config.sandbox.boreServer = ack.bore.server;
    config.sandbox.boreSecret = ack.bore.secret;
    console.log(`[agent] registered as node ${nodeId}; earnings go to ${ack.ownerAddr}`);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      const hb: HeartbeatMsg = { nodeId: nodeId! };
      socket.emit(WS.heartbeat, hb);
    }, config.heartbeatIntervalMs);
  });

  socket.on("error-message", (m: string) => console.error(`[agent] registry error: ${m}`));

  socket.on(WS.startContainer, (msg: StartContainerMsg) => handleStart(socket, msg));
  socket.on(WS.destroyContainer, (msg: DestroyContainerMsg) => handleDestroy(msg.leaseId));
  socket.on(WS.runJob, (msg: RunJobMsg) => handleRun(socket, msg));

  socket.on("disconnect", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    console.log("[agent] disconnected from registry; stopping sandboxes");
    void shutdown();
  });

  process.on("SIGINT", async () => {
    console.log("\n[agent] shutting down, destroying sandboxes...");
    await shutdown();
    process.exit(0);
  });
}

async function handleStart(socket: Socket, msg: StartContainerMsg) {
  try {
    activeLeases.add(msg.leaseId);
    const { host, port } = await startSandbox(
      msg.leaseId,
      msg.image,
      msg.limits,
      msg.sshPassword,
      msg.sshPubKey,
      msg.surface ?? "ssh",
      msg.lifetimeMs,
    );
    if (!activeLeases.has(msg.leaseId)) {
      await stopSandbox(msg.leaseId);
      return;
    }
    const ready: ContainerReadyMsg = { leaseId: msg.leaseId, host, port };
    socket.emit(WS.containerReady, ready);
    console.log(`[agent] lease ${msg.leaseId} ready${msg.surface === "exec" ? " — private exec" : ` — ssh ${SANDBOX_USER}@${host} -p ${port}`}`);
  } catch (err) {
    await handleDestroy(msg.leaseId);
    const failed: ContainerFailedMsg = { leaseId: msg.leaseId, error: (err as Error).message };
    socket.emit(WS.containerFailed, failed);
    console.error(`[agent] lease ${msg.leaseId} failed: ${(err as Error).message}`);
  }
}

async function handleDestroy(leaseId: string) {
  activeLeases.delete(leaseId);
  await stopSandbox(leaseId);
  console.log(`[agent] lease ${leaseId} torn down`);
}

async function handleRun(socket: Socket, msg: RunJobMsg) {
  if (!activeLeases.has(msg.leaseId)) {
    socket.emit(WS.jobResult, { jobId: msg.jobId, ok: false, result: "sandbox is not active" });
    return;
  }
  const { ok, output } = await runInSandbox(msg.leaseId, msg.payload, msg.timeoutMs);
  const result: JobResultMsg = { jobId: msg.jobId, ok, result: output };
  socket.emit(WS.jobResult, result);
}

async function shutdown() {
  await Promise.all([...activeLeases].map((leaseId) => handleDestroy(leaseId)));
  await stopWarmExecPool();
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
