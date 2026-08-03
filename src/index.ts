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
import { loadKey } from "./keys.js";
import { detectSpecs } from "./specs.js";
import { runInSandbox, startSandbox, stopSandbox } from "./docker.js";

if (!config.privateKeyB64) {
  console.error("AVM_PRIVATE_KEY is required. Generate one with: npm run keygen");
  process.exit(1);
}

const { address, signNonce } = loadKey(config.privateKeyB64);
const payToAddr = config.payToAddr || address;

/** Lease ids of sandboxes this agent is currently hosting. */
const activeLeases = new Set<string>();
let nodeId: string | undefined;

async function main() {
  const specs = await detectSpecs();
  console.log(`[agent] owner=${address}`);
  console.log(`[agent] specs: ${specs.cpuCores} CPU, ${specs.ramMb}MB RAM, GPU=${specs.gpu ?? "none"}`);
  console.log(`[agent] price: $${config.pricePerHourUsd}/hr -> paid to ${payToAddr}`);

  const nonce = await fetchNonce();
  const socket = io(config.registryUrl, { transports: ["websocket"] });

  socket.on("connect", () => {
    const hello: AgentHelloMsg = {
      ownerAddr: address,
      signature: signNonce(nonce),
      nonce,
      spec: {
        ownerAddr: address,
        payToAddr,
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
    console.log(`[agent] registered as node ${nodeId}; sending heartbeats`);
    setInterval(() => {
      const hb: HeartbeatMsg = { nodeId: nodeId! };
      socket.emit(WS.heartbeat, hb);
    }, config.heartbeatIntervalMs);
  });

  socket.on("error-message", (m: string) => console.error(`[agent] registry error: ${m}`));

  socket.on(WS.startContainer, (msg: StartContainerMsg) => handleStart(socket, msg));
  socket.on(WS.destroyContainer, (msg: DestroyContainerMsg) => handleDestroy(msg.leaseId));
  socket.on(WS.runJob, (msg: RunJobMsg) => handleRun(socket, msg));

  socket.on("disconnect", () => console.log("[agent] disconnected from registry"));

  process.on("SIGINT", async () => {
    console.log("\n[agent] shutting down, destroying sandboxes...");
    await shutdown();
    process.exit(0);
  });
}

async function fetchNonce(): Promise<string> {
  const res = await fetch(`${config.registryUrl}/auth/nonce?address=${address}`);
  if (!res.ok) throw new Error(`failed to fetch nonce: ${res.status}`);
  const data = (await res.json()) as { nonce: string };
  return data.nonce;
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
    );
    const ready: ContainerReadyMsg = { leaseId: msg.leaseId, host, port };
    socket.emit(WS.containerReady, ready);
    console.log(`[agent] lease ${msg.leaseId} ready — ssh root@${host} -p ${port}`);
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
  const { ok, output } = await runInSandbox(msg.leaseId, msg.payload);
  const result: JobResultMsg = { jobId: msg.jobId, ok, result: output };
  socket.emit(WS.jobResult, result);
}

async function shutdown() {
  await Promise.all([...activeLeases].map((leaseId) => handleDestroy(leaseId)));
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
