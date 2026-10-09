import { runInSandbox, startSandbox, stopSandbox } from "../docker.js";
import { LEGACY_CAPABILITIES } from "../protocol.js";
import type { RuntimeDriver, RunningLease } from "./types.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "./process.js";
import { setTimeout as delay } from "node:timers/promises";

export const dockerEffects = { command, startSandbox, stopSandbox, runInSandbox };

/** Legacy isolation with the same acknowledged lifecycle as the VM driver. */
export function dockerDriver(): RuntimeDriver {
  const live = new Map<string, { cancelled: boolean; running: boolean; abort: AbortController; start: Promise<RunningLease>; stop?: Promise<void>; jobs: Set<Promise<unknown>>; dir?: string }>();
  const destroyed = new Set<string>();
  return {
    kind: "docker", capabilities: { ...LEGACY_CAPABILITIES },
    start(lease) {
      const prior = live.get(lease.leaseId);
      if (prior) return prior.start;
      if (destroyed.has(lease.leaseId)) return Promise.reject(new Error("lease already destroyed"));
      if (lease.surface === "jupyter" || lease.notebook) return Promise.reject(new Error("legacy Docker does not support notebooks"));
      const row = { cancelled: false, running: false, abort: new AbortController(), jobs: new Set<Promise<unknown>>(), start: Promise.resolve(null as unknown as RunningLease), stop: undefined as Promise<void> | undefined, dir: undefined as string | undefined };
      live.set(lease.leaseId, row);
      row.start = (async () => {
        const signal = row.abort.signal;
        const timer = setTimeout(() => row.abort.abort(), Math.max(0, (lease.deadline ?? Date.now() + 45_000) - Date.now()));
        try {
          let keys = lease.sshPubKey;
          if (lease.surface !== "exec") {
            row.dir = await mkdtemp(join(tmpdir(), "tendril-docker-"));
            await dockerEffects.command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(row.dir, "exec"), "-q"], { signal });
            keys = [keys, (await readFile(join(row.dir, "exec.pub"), "utf8")).trim()].filter(Boolean).join("\n");
          }
          if (lease.surface !== "exec" && !lease.relay?.ssh) throw new Error("SSH relay allocation missing");
          const endpoint = await dockerEffects.startSandbox(lease.leaseId, lease.image, lease.limits, lease.sshPubKey ? null : lease.sshPassword, keys, lease.surface === "exec", lease.relay, signal);
          signal.throwIfAborted();
          if (row.cancelled || (lease.deadline && Date.now() >= lease.deadline)) throw new Error("lease cancelled during Docker start");
          if (row.dir) {
            let pub: string;
            while (true) {
              try {
                pub = (await dockerEffects.command("docker", ["exec", endpoint.containerName, "python3", "-c", "import pathlib; print(pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().strip())"], { signal })).stdout.trim().split(" ").slice(0, 2).join(" ");
                break;
              } catch { signal.throwIfAborted(); await delay(100, undefined, { signal }); }
            }
            const hosts = join(row.dir, "known_hosts");
            await writeFile(hosts, `${endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`} ${pub}\n`, { mode: 0o600 });
            while (true) {
              try {
                await dockerEffects.command("ssh", ["-i", join(row.dir, "exec"), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hosts}`,
                  "-o", "ConnectTimeout=2", "-p", String(endpoint.port), `root@${endpoint.host}`, "true"], { signal, timeoutMs: 5000 });
                break;
              } catch { signal.throwIfAborted(); await delay(100, undefined, { signal }); }
            }
          }
          signal.throwIfAborted();
          row.running = true;
          return { leaseId: lease.leaseId, host: endpoint.host, port: endpoint.port, access: lease.surface === "exec" ? null : {
            kind: "ssh" as const, host: endpoint.host, port: endpoint.port, username: "root",
            authMethod: lease.sshPubKey ? "publickey" as const : "password" as const, password: lease.sshPubKey ? null : lease.sshPassword,
            command: `ssh root@${endpoint.host} -p ${endpoint.port}`,
          } };
        } catch (err) { await dockerEffects.stopSandbox(lease.leaseId); if (row.dir) await rm(row.dir, { recursive: true, force: true }); throw err; }
        finally { clearTimeout(timer); }
      })();
      return row.start;
    },
    stop(leaseId) {
      const row = live.get(leaseId);
      destroyed.add(leaseId);
      if (!row) return dockerEffects.stopSandbox(leaseId);
      if (row.stop) return row.stop;
      row.cancelled = true;
      row.abort.abort();
      row.stop = (async () => {
        await row.start.catch(() => undefined);
        await dockerEffects.stopSandbox(leaseId);
        await Promise.allSettled([...row.jobs]);
        if (row.dir) await rm(row.dir, { recursive: true, force: true });
        live.delete(leaseId);
      })().finally(() => { row.stop = undefined; });
      return row.stop;
    },
    exec(leaseId, payload, timeoutMs, notebookJobId) {
      if (notebookJobId) throw new Error("legacy Docker does not support notebooks");
      const row = live.get(leaseId);
      if (!row?.running || row.cancelled) throw new Error("lease not running");
      const task = dockerEffects.runInSandbox(leaseId, payload, timeoutMs, row.abort.signal);
      row.jobs.add(task);
      return task.finally(() => row.jobs.delete(task));
    },
  };
}
