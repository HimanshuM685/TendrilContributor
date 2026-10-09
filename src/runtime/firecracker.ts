import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chown, chmod, cp, mkdir, readFile, readdir, rm, rmdir, writeFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";
import { command, terminate } from "./process.js";
import { cloneRootfs, type RootfsTemplate } from "./rootfs.js";
import { createNetwork, networkFor, removeNetwork, type GuestNetwork } from "./network.js";
import type { LeaseRequest, RuntimeDriver, RunningLease } from "./types.js";

export function vmId(leaseId: string): string { return `tnd-${createHash("sha256").update(leaseId).digest("hex").slice(0, 24)}`; }
export function memoryMib(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([gmk])b?$/i.exec(raw);
  if (!m) throw new Error("memory must have a g/m/k suffix");
  const value = Math.ceil(Number(m[1]) * ({ g: 1024, m: 1, k: 1 / 1024 }[m[2].toLowerCase()]!));
  if (!Number.isFinite(value) || value < 128) throw new Error("guest memory must be at least 128 MiB");
  return value;
}
export interface BootConfigInput {
  kernelPath: string; rootfsPath: string; tap: string; guestMac: string; vcpus: number; memMib: number; guestIp: string; hostIp: string;
}
export function buildBootConfig(o: BootConfigInput): Record<string, unknown> {
  if (!Number.isFinite(o.vcpus) || o.vcpus <= 0 || o.vcpus > 32 || !Number.isInteger(o.memMib) || o.memMib < 128) throw new Error("invalid VM limits");
  return {
    "boot-source": { kernel_image_path: o.kernelPath, boot_args: "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/tendril-init.sh" },
    drives: [{ drive_id: "rootfs", path_on_host: o.rootfsPath, is_root_device: true, is_read_only: false }],
    "network-interfaces": [{ iface_id: "eth0", guest_mac: o.guestMac, host_dev_name: o.tap }],
    "machine-config": { vcpu_count: Math.ceil(o.vcpus), mem_size_mib: o.memMib },
  };
}
export interface JailerArgvInput {
  jailer: string; firecracker: string; id: string; uid: number; gid: number; chrootBase: string;
  namespace?: string; cgroupParent?: string; cpus?: number; memoryMib?: number; overheadMib?: number;
}
export function jailerArgv(o: JailerArgvInput): string[] {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(o.id) || o.uid <= 0 || o.gid <= 0) throw new Error("invalid jailer identity");
  const args = [o.jailer, "--id", o.id, "--exec-file", o.firecracker, "--uid", String(o.uid), "--gid", String(o.gid),
    "--chroot-base-dir", o.chrootBase, "--cgroup-version", "2", "--parent-cgroup", o.cgroupParent ?? "tendril",
    "--cgroup", `cpu.max=${Math.floor((o.cpus ?? 1) * 100000)} 100000`,
    "--cgroup", `memory.max=${((o.memoryMib ?? 2048) + (o.overheadMib ?? 128)) * 1024 ** 2}`,
    "--cgroup", "memory.swap.max=0", "--cgroup", "pids.max=256", "--resource-limit", "no-file=256"];
  if (o.namespace) args.push("--netns", `/var/run/netns/${o.namespace}`);
  return [...args, "--", "--no-api", "--config-file", "/config.json"];
}
export async function removeLeaseDir(dir: string) { await rm(dir, { recursive: true, force: true }); }

interface Vm {
  leaseId: string; id: string; dir: string; jailDir: string; network: GuestNetwork; cgroup: string;
  phase: "preparing" | "running" | "stopping" | "destroyed";
  abort: AbortController; child?: ChildProcess; start?: Promise<RunningLease>; stop?: Promise<void>;
  executions: Set<Promise<unknown>>;
  pid?: number;
  startTicks?: string;
}
export interface FirecrackerOptions {
  kernelPath: string; jailerBin: string; firecrackerBin: string; stateDir: string; template: RootfsTemplate;
  uid?: number; gid?: number; cgroupParent?: string; overheadMib?: number;
}
export function firecrackerDriver(o: FirecrackerOptions): RuntimeDriver {
  const root = resolve(o.stateDir || "/var/lib/tendril");
  const live = new Map<string, Vm>(), tombstones = new Set<string>();
  const uid = o.uid ?? config.jailerUid, gid = o.gid ?? config.jailerGid;
  const parent = o.cgroupParent ?? config.cgroupParent;
  const ticks = async (pid: number) => {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
  };
  const manifest = async (row: Vm) => {
    const path = join(row.dir, "manifest.json");
    const { rename } = await import("node:fs/promises");
    await writeFile(`${path}.new`, JSON.stringify({ leaseId: row.leaseId, id: row.id, index: row.network.index, pid: row.pid, startTicks: row.startTicks }), { mode: 0o600 });
    await rename(`${path}.new`, path);
  };
  const cgroupKill = async (row: Vm) => {
    if (await stat(row.cgroup).catch(() => null)) {
      await writeFile(join(row.cgroup, "cgroup.kill"), "1");
      for (let i = 0; i < 50; i++) {
        if (!(await readFile(join(row.cgroup, "cgroup.procs"), "utf8")).trim()) return;
        await delay(100);
      }
      throw new Error("VMM cgroup still populated");
    }
  };
  const cleanup = async (row: Vm) => {
    row.phase = "stopping";
    row.abort.abort();
    await Promise.allSettled([...row.executions]);
    if (row.child) await terminate(row.child);
    await cgroupKill(row);
    // Covers a jailer that died/restarted before joining its cgroup. Never kill a reused PID.
    if (row.pid && row.startTicks && await ticks(row.pid).then((value) => value === row.startTicks).catch(() => false)) {
      try { process.kill(-row.pid, "SIGKILL"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
    }
    await removeNetwork(row.network);
    if (await stat(row.cgroup).catch(() => null)) await rmdir(row.cgroup);
    await removeLeaseDir(row.jailDir);
    await removeLeaseDir(row.dir);
    row.phase = "destroyed";
    live.delete(row.leaseId);
    tombstones.add(row.leaseId);
  };
  const ssh = (row: Vm, host: string, port: number, args: string[], input?: string, timeoutMs = 5000, privateTap = true) => {
    const sshArgs = ["ssh", "-i", join(row.dir, "exec"), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${join(row.dir, "known_hosts")}`, "-o", "ConnectTimeout=2", "-p", String(port), `root@${host}`, ...args];
    return privateTap ? command("ip", ["netns", "exec", row.network.namespace, ...sshArgs], { signal: row.abort.signal, input, timeoutMs })
      : command("ssh", sshArgs.slice(1), { signal: row.abort.signal, input, timeoutMs });
  };
  const driver: RuntimeDriver = {
    kind: "microvm", capabilities: { ssh: true, python: true, notebook: true, jupyter: true },
    start(lease) {
      const found = live.get(lease.leaseId);
      if (found?.start) return found.start;
      if (tombstones.has(lease.leaseId)) return Promise.reject(new Error("lease already destroyed"));
      if (lease.image && lease.image !== o.template.image) return Promise.reject(new Error("image has no prepared guest template"));
      const used = new Set([...live.values()].map((v) => v.network.index));
      let index = 0; while (used.has(index) && index < 4096) index++;
      if (index === 4096) return Promise.reject(new Error("guest network pool exhausted"));
      const id = vmId(lease.leaseId);
      const row: Vm = { leaseId: lease.leaseId, id, dir: join(root, "leases", id),
        jailDir: join(root, "jail", basename(o.firecrackerBin), id), cgroup: join("/sys/fs/cgroup", parent, id),
        network: networkFor(id, index), phase: "preparing", abort: new AbortController(), executions: new Set() };
      live.set(lease.leaseId, row);
      row.start = (async () => {
        const deadline = lease.deadline ?? Date.now() + 45_000;
        const timer = setTimeout(() => row.abort.abort(), Math.max(0, deadline - Date.now()));
        try {
          await mkdir(row.dir, { recursive: true, mode: 0o700 });
          await manifest(row);
          const signal = row.abort.signal;
          await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(row.dir, "exec"), "-q"], { signal });
          await command("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(row.dir, "host"), "-q"], { signal });
          const hostPub = (await readFile(join(row.dir, "host.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ");
          const known = [`${row.network.guestIp} ${hostPub}`];
          if (lease.relay?.ssh) known.push(`[${lease.relay.ssh.publicHost}]:${lease.relay.ssh.publicPort} ${hostPub}`);
          await writeFile(join(row.dir, "known_hosts"), known.join("\n") + "\n", { mode: 0o600 });
          const guest = { password: lease.sshPubKey ? null : lease.sshPassword,
            keys: [lease.sshPubKey, (await readFile(join(row.dir, "exec.pub"), "utf8")).trim()].filter(Boolean),
            ip: row.network.guestIp, gateway: row.network.gateway, dns: config.guestDns,
            relay: lease.relay, token: lease.jupyterToken, notebook: !!lease.relay?.notebook };
          const jailRoot = join(row.jailDir, "root");
          await cloneRootfs(o.template, join(jailRoot, "rootfs.ext4"), {
            "/etc/tendril/lease.json": JSON.stringify(guest), "/etc/ssh/ssh_host_ed25519_key": await readFile(join(row.dir, "host"), "utf8"),
          }, uid, gid, signal);
          await cp(o.kernelPath, join(jailRoot, "vmlinux"));
          const cpus = Number(lease.limits.cpus || config.sandbox.cpus), mem = memoryMib(lease.limits.memory || config.sandbox.memory);
          await writeFile(join(jailRoot, "config.json"), JSON.stringify(buildBootConfig({ kernelPath: "vmlinux", rootfsPath: "rootfs.ext4",
            tap: row.network.tap, guestMac: "06:00:0a:c8:00:02", vcpus: cpus, memMib: mem, guestIp: row.network.guestIp, hostIp: row.network.gateway })));
          for (const file of [row.jailDir, jailRoot, join(jailRoot, "vmlinux"), join(jailRoot, "config.json")]) await chown(file, uid, gid);
          await chmod(jailRoot, 0o700);
          await chmod(join(jailRoot, "vmlinux"), 0o400);
          await createNetwork(row.network, uid, signal);
          signal.throwIfAborted();
          const argv = jailerArgv({ jailer: o.jailerBin, firecracker: o.firecrackerBin, id, uid, gid, chrootBase: join(root, "jail"),
            namespace: row.network.namespace, cgroupParent: parent, cpus, memoryMib: mem, overheadMib: o.overheadMib });
          const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
          row.child = child;
          row.pid = child.pid;
          let bootError: Error | undefined;
          child.on("error", (err) => { bootError = err; });
          // Drain serial output without logging guest credentials or retaining unbounded buffers.
          child.stdout?.resume(); child.stderr?.resume();
          child.once("close", () => { if (row.phase === "running") driver.onFailure?.(row.leaseId); });
          if (child.pid) { row.startTicks = await ticks(child.pid).catch(() => undefined); await manifest(row); }
          while (true) {
            signal.throwIfAborted();
            if (bootError || child.exitCode !== null || child.signalCode !== null) throw bootError ?? new Error("guest boot exited");
            try {
              const kernel = (await ssh(row, row.network.guestIp, 22, ["uname", "-r"])).stdout.trim();
              if (!kernel.endsWith("-tendril") || kernel === release()) throw new Error("guest kernel identity failed");
              break;
            } catch (err) {
              if ((err as Error).message === "guest kernel identity failed") throw err;
              await delay(250, undefined, { signal });
            }
          }
          if ((lease.surface ?? "ssh") === "ssh") {
            const relay = lease.relay?.ssh;
            if (!relay) throw new Error("SSH relay allocation missing");
            while (true) {
              try { await ssh(row, relay.publicHost, relay.publicPort, ["true"], undefined, 5000, false); break; }
              catch { signal.throwIfAborted(); await delay(250, undefined, { signal }); }
            }
            row.phase = "running";
            const access = { kind: "ssh" as const, host: relay.publicHost, port: relay.publicPort, username: "root",
              authMethod: lease.sshPubKey ? "publickey" as const : "password" as const, password: lease.sshPubKey ? null : lease.sshPassword,
              command: `ssh root@${relay.publicHost} -p ${relay.publicPort}` };
            return { leaseId: lease.leaseId, access, host: access.host, port: access.port };
          }
          row.phase = "running";
          return { leaseId: lease.leaseId, access: null, host: "", port: 0 };
        } catch (err) {
          await cleanup(row).catch(() => undefined); // manifest retained if cleanup needs retry
          throw err;
        } finally { clearTimeout(timer); }
      })();
      return row.start;
    },
    stop(leaseId) {
      const row = live.get(leaseId);
      if (!row) { tombstones.add(leaseId); return Promise.resolve(); }
      if (row.stop) return row.stop;
      row.abort.abort();
      row.stop = (async () => { await row.start?.catch(() => undefined); if (row.phase !== "destroyed") await cleanup(row); })()
        .finally(() => { row.stop = undefined; });
      return row.stop;
    },
    async exec(leaseId, payload, timeoutMs = 120_000, notebookJobId) {
      const row = live.get(leaseId);
      if (!row || row.phase !== "running") throw new Error("lease not running");
      if (notebookJobId && !/^[A-Za-z0-9_-]{1,64}$/.test(notebookJobId)) throw new Error("invalid job id");
      const request = { payload: notebookJobId ? undefined : payload, jobId: notebookJobId, timeout: timeoutMs / 1000 };
      try {
        const task = ssh(row, row.network.guestIp, 22, ["/usr/local/bin/tendril-job"], JSON.stringify(request), timeoutMs + 2000);
        row.executions.add(task);
        const result = await task.finally(() => row.executions.delete(task));
        return JSON.parse(result.stdout) as { ok: boolean; output: string };
      } catch (err) { return { ok: false, output: (err as Error).message }; }
    },
    async reconcile() {
      await mkdir(join(root, "leases"), { recursive: true, mode: 0o700 });
      for (const id of await readdir(join(root, "leases"))) {
        if (!/^tnd-[a-f0-9]{24}$/.test(id)) continue;
        const path = join(root, "leases", id, "manifest.json");
        if (!await stat(path).catch(() => null)) { await removeLeaseDir(join(root, "leases", id)); continue; }
        const meta = JSON.parse(await readFile(path, "utf8")) as { leaseId: string; index: number; pid?: number; startTicks?: string };
        if (vmId(meta.leaseId) !== id || !Number.isInteger(meta.index) || meta.index < 0 || meta.index >= 4096) throw new Error("invalid orphan metadata");
        const row: Vm = { leaseId: meta.leaseId, id, dir: join(root, "leases", id), jailDir: join(root, "jail", basename(o.firecrackerBin), id),
          cgroup: join("/sys/fs/cgroup", parent, id), network: networkFor(id, meta.index), phase: "stopping", abort: new AbortController(), executions: new Set() };
        if (Number.isInteger(meta.pid) && meta.pid! > 1) { row.pid = meta.pid; row.startTicks = meta.startTicks; }
        await cleanup(row);
      }
    },
  };
  return driver;
}
