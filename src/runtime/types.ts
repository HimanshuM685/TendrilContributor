import type { SandboxRuntime, SandboxCapabilities, SandboxAccess, StartContainerMsg } from "../protocol.js";
export type LeaseRequest = StartContainerMsg;
export interface RunningLease { leaseId: string; access: SandboxAccess | null; host: string; port: number; guestIp?: string }
export interface RuntimeDriver {
  kind: SandboxRuntime;
  capabilities: SandboxCapabilities;
  start(lease: LeaseRequest): Promise<RunningLease>;
  stop(leaseId: string): Promise<void>;
  exec(leaseId: string, payload: string, timeoutMs?: number, notebookJobId?: string): Promise<{ ok: boolean; output: string }>;
  reconcile?(): Promise<void>;
  onFailure?: (leaseId: string) => void;
}
