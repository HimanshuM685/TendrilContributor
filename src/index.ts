import { io } from "socket.io-client";
import { WS, type AgentHelloMsg, type ContainerDestroyedMsg, type HeartbeatMsg, type HelloAckMsg,
  type StartContainerMsg, type DestroyContainerMsg, type RunJobMsg } from "./protocol.js";
import { config } from "./config.js";
import { detectSpecs } from "./specs.js";
import { selectDriver } from "./runtime/select.js";

async function main() {
  if (!config.apiKey) throw new Error("TENDRIL_API_KEY required");
  const { driver, kvm } = await selectDriver();
  const specs = await detectSpecs();
  const active = new Set<string>(), destroyed = new Set<string>();
  let nodeId: string | undefined, heartbeat: NodeJS.Timeout | undefined, shuttingDown = false;
  const socket = io(config.registryUrl, { transports: ["websocket"] });
  const stop = async (leaseId: string) => {
    try {
      await driver.stop(leaseId);
      active.delete(leaseId); destroyed.add(leaseId);
      const msg: ContainerDestroyedMsg = { leaseId, ok: true };
      socket.emit(WS.containerDestroyed, msg);
    } catch { socket.emit(WS.containerDestroyed, { leaseId, ok: false, error: "local cleanup pending" }); }
  };
  driver.onFailure = (leaseId) => {
    socket.emit(WS.containerFailed, { leaseId, error: "guest exited unexpectedly" });
    void stop(leaseId);
  };
  socket.on("connect", () => {
    const hello: AgentHelloMsg = { nodeId, apiKey: config.apiKey, spec: { label: config.label, cpuCores: specs.cpuCores, ramMb: specs.ramMb,
      gpu: driver.kind === "microvm" ? null : specs.gpu, pricePerHourUsd: config.pricePerHourUsd, runtime: driver.kind, kvm, capabilities: driver.capabilities } };
    socket.emit(WS.hello, hello);
  });
  socket.on(WS.helloAck, (ack: HelloAckMsg) => {
    nodeId = ack.nodeId; config.sandbox.boreServer = ack.bore.server; config.sandbox.boreSecret = ack.bore.secret;
    if (heartbeat) clearInterval(heartbeat);
    const beat = () => { const msg: HeartbeatMsg = { nodeId: nodeId!, runtime: driver.kind, kvm, capabilities: driver.capabilities, destroyed: [...destroyed] }; socket.emit(WS.heartbeat, msg); };
    heartbeat = setInterval(beat, config.heartbeatIntervalMs); beat();
    console.log(`[agent] ${nodeId} runtime=${driver.kind} kvm=${kvm}`);
  });
  socket.on(WS.startContainer, (msg: StartContainerMsg) => {
    if (shuttingDown) { socket.emit(WS.containerFailed, { leaseId: msg.leaseId, error: "agent shutting down" }); return; }
    active.add(msg.leaseId);
    void driver.start(msg).then((running) => {
      if (!active.has(msg.leaseId) || destroyed.has(msg.leaseId)) return;
      socket.emit(WS.containerReady, { leaseId: msg.leaseId, host: running.host, port: running.port, access: running.access });
    }).catch(async () => {
      await stop(msg.leaseId);
      socket.emit(WS.containerFailed, { leaseId: msg.leaseId, error: "guest provisioning failed" });
    });
  });
  socket.on(WS.destroyContainer, (msg: DestroyContainerMsg) => void stop(msg.leaseId));
  socket.on(WS.runJob, (msg: RunJobMsg) => {
    void driver.exec(msg.leaseId, msg.payload, Math.max(1, (msg.deadline ?? Date.now() + 120_000) - Date.now()), msg.notebookJob ? msg.jobId : undefined)
      .then(({ ok, output }) => socket.emit(WS.jobResult, { jobId: msg.jobId, ok, result: output }))
      .catch(() => socket.emit(WS.jobResult, { jobId: msg.jobId, ok: false, result: "guest execution failed" }));
  });
  socket.on("disconnect", () => {
    if (heartbeat) clearInterval(heartbeat);
    void Promise.all([...active].map(stop));
  });
  socket.on("error-message", (message: string) => console.error(`[agent] ${message}`));
  const shutdown = async () => {
    shuttingDown = true;
    if (heartbeat) clearInterval(heartbeat);
    await Promise.all([...active].map(stop));
    if (active.size) { console.error("[agent] cleanup pending; restart will reconcile"); process.exit(1); }
    socket.disconnect(); process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown());
}
main().catch((err) => { console.error("[agent] startup failed:", (err as Error).message); process.exitCode = 1; });
