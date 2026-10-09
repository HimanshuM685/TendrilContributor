/**
 * The registry ↔ contributor WebSocket contract.
 *
 * This is the contributor's copy of the wire types the Tendril backend speaks
 * over socket.io. It is intentionally a plain file rather than a shared package:
 * the agent is a standalone daemon, and the contract is small and stable.
 * Anything the agent never sends or receives is deliberately absent.
 */

/** Resource caps the registry asks the agent to enforce on a container. */
export interface SandboxLimits {
  memory: string; // e.g. "2g"
  cpus: number;
  gpus: string; // "all" or "" (none)
}

/**
 * The node specs advertised at registration. Owner and payout address are
 * deliberately absent — both come from the API key the agent authenticates with.
 */
export interface RegisterNodeRequest {
  label: string;
  cpuCores: number;
  ramMb: number;
  gpu: string | null;
  pricePerHourUsd: number;
}

/**
 * agent -> registry: authenticate the socket, registering (or re-attaching to)
 * a node. Carries the node's advertised specs so registration + auth happen in
 * one message.
 *
 * Auth is an API key minted in the web UI by a signed-in wallet. The agent
 * therefore holds no Algorand private key: the key's owner *is* the node's owner
 * and payout address, so neither can be spoofed from the contributor's env.
 */
export interface AgentHelloMsg {
  /** Existing node id to re-attach to, or omit/empty to create a new one. */
  nodeId?: string;
  /** Contributor API key (`tnd_…`) from the web UI's contributor section. */
  apiKey: string;
  /** Advertised node specs. */
  spec: RegisterNodeRequest;
}

/**
 * registry -> agent: hello accepted. Carries the canonical node id plus the
 * settings the contributor no longer configures locally — the backend owns the
 * tunnel and the payout address.
 */
export interface HelloAckMsg {
  nodeId: string;
  /** Wallet that minted the API key — earns for this node. */
  ownerAddr: string;
  /** Reverse-tunnel settings for the sandbox, chosen by the backend. */
  bore: { server: string; secret: string };
}

/** agent -> registry: periodic liveness ping. */
export interface HeartbeatMsg {
  nodeId: string;
}

/** registry -> agent: spin up a sandbox for a paid lease. */
export interface StartContainerMsg {
  leaseId: string;
  image: string;
  limits: SandboxLimits;
  /** SSH password to set inside the sandbox (the renter's address), or null. */
  sshPassword: string | null;
  /**
   * OpenSSH public key to write to the sandbox's `authorized_keys`. Takes
   * precedence over `sshPassword` and is the only option that works for a
   * renter with no session (nothing to use as a password).
   */
  sshPubKey: string | null;
}

/** agent -> registry: the sandbox is up and reachable for SSH at host:port. */
export interface ContainerReadyMsg {
  leaseId: string;
  /** SSH host (bore endpoint, or 127.0.0.1 in local mode). */
  host: string;
  /** SSH port. */
  port: number;
}

/** agent -> registry: the sandbox failed to start. */
export interface ContainerFailedMsg {
  leaseId: string;
  error: string;
}

/** registry -> agent: tear down the sandbox for a lease. */
export interface DestroyContainerMsg {
  leaseId: string;
}

/** registry -> agent: run a job inside an existing lease's sandbox. */
export interface RunJobMsg {
  leaseId: string;
  jobId: string;
  payload: string;
}

/** agent -> registry: job finished (or errored). */
export interface JobResultMsg {
  jobId: string;
  ok: boolean;
  result: string;
}

/** Socket.io event names, centralized to avoid typos across processes. */
export const WS = {
  hello: "hello",
  helloAck: "hello-ack",
  heartbeat: "heartbeat",
  startContainer: "start-container",
  containerReady: "container-ready",
  containerFailed: "container-failed",
  destroyContainer: "destroy-container",
  runJob: "run-job",
  jobResult: "job-result",
} as const;
