/**
 * The registry ↔ contributor WebSocket contract.
 *
 * This is the contributor's copy of the wire types the Tendril backend speaks
 * over socket.io. It is intentionally a plain file rather than a shared package:
 * the agent is a standalone daemon, and the contract is small and stable.
 * Anything the agent never sends or receives is deliberately absent.
 */

/**
 * How a contributor isolates a lease. gVisor is a published value only — this
 * tree ships Docker (legacy) and Firecracker drivers, not a gVisor one.
 */
export type SandboxRuntime = "docker" | "gvisor" | "microvm";

export type SandboxCapability = "ssh" | "python" | "notebook" | "jupyter";
export type SandboxCapabilities = Record<SandboxCapability, boolean>;
export const LEGACY_CAPABILITIES: SandboxCapabilities = { ssh: true, python: true, notebook: false, jupyter: false };

export type SandboxSurface = "ssh" | "jupyter" | "exec";

/** Per-lease relay credentials. Never part of a public node or billing record. */
export interface RelayTunnel {
  controlHost: string;
  controlPort: number;
  secret: string;
  remotePort: number;
  publicHost: string;
  publicPort: number;
}
export interface LeaseRelay {
  ssh?: RelayTunnel;
  notebook?: RelayTunnel;
}

/** SSH into a contributor sandbox. */
export interface SshAccess {
  kind: "ssh";
  /** Host to SSH to (e.g. a bore endpoint, or 127.0.0.1 in local mode). */
  host: string;
  port: number;
  username: string;
  /**
   * `"publickey"` when the renter supplied an `sshPubKey`. Otherwise `"password"`
   * uses the verified payer address; neither requires a sign-in session.
   */
  authMethod: "password" | "publickey";
  /** SSH password (the renter's address), or null under `"publickey"`. */
  password: string | null;
   /** Ready-to-copy connect command, e.g. "ssh root@lease.ssh.example.com -p 20000". */
  command: string;
}

/**
 * JupyterLab on a capable contributor or hosted sandbox. `token` is a per-lease secret for the lab,
 * never the renter's wallet address and never the billing lease JWT.
 */
export interface JupyterAccess {
  kind: "jupyter";
  /** Tunnel URL including `?token=`. */
  url: string;
  token: string;
}

/** How a renter reaches a running sandbox. */
export type SandboxAccess = SshAccess | JupyterAccess;

/** Resource caps the registry asks the agent to enforce on a container. */
export interface SandboxLimits {
  memory: string; // e.g. "2g"
  cpus: number;
  gpus: string; // "all" or "" (none)
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
  /** Isolation this agent will actually start. Omit on older agents. */
  runtime?: SandboxRuntime;
  /** Whether `/dev/kvm` exists on the contributor host. */
  kvm?: boolean;
  capabilities?: Partial<SandboxCapabilities>;
  /** Successful local cleanup, replayed after reconnect until acknowledged. */
  destroyed?: string[];
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
  surface?: SandboxSurface;
  notebook?: boolean;
  deadline?: number;
  relay?: LeaseRelay;
  jupyterToken?: string;
}

/** agent -> registry: the sandbox is up and reachable for SSH at host:port. */
export interface ContainerReadyMsg {
  leaseId: string;
  /** SSH host (bore endpoint, or 127.0.0.1 in local mode). */
  host: string;
  /** SSH port. */
  port: number;
  access?: SandboxAccess | null;
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

export interface ContainerDestroyedMsg {
  leaseId: string;
  ok: boolean;
  error?: string;
}

/** registry -> agent: run a job inside an existing lease's sandbox. */
export interface RunJobMsg {
  leaseId: string;
  jobId: string;
  payload: string;
  /** Only a reference: notebook bytes use the private Jupyter HTTP endpoint. */
  notebookJob?: boolean;
  deadline?: number;
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
  containerDestroyed: "container-destroyed",
  destroyContainer: "destroy-container",
  runJob: "run-job",
  jobResult: "job-result",
} as const;

/**
 * What a node advertises about itself. Owner and payout address are deliberately
 * absent — both come from the API key the agent authenticates with.
 */
export interface RegisterNodeRequest {
  label: string;
  cpuCores: number;
  ramMb: number;
  gpu: string | null;
  pricePerHourUsd: number;
  /** Set by the agent from the driver it selected. Defaults to docker. */
  runtime?: SandboxRuntime;
  kvm?: boolean;
  capabilities?: Partial<SandboxCapabilities>;
}
