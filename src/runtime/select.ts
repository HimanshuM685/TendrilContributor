import { constants } from "node:fs";
import { access, mkdir, realpath, readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { config } from "../config.js";
import { dockerDriver } from "./docker.js";
import { firecrackerDriver } from "./firecracker.js";
import { prepareRootfs } from "./rootfs.js";
import { command } from "./process.js";
import type { RuntimeDriver } from "./types.js";

export function advertise(o: { kvmDevice: boolean; canBootMicrovm: boolean }) {
  return { runtime: o.kvmDevice && o.canBootMicrovm ? "microvm" as const : "docker" as const, kvm: o.kvmDevice };
}
async function executable(bin: string) {
  if (bin.includes("/")) return realpath(bin);
  for (const path of (process.env.PATH ?? "").split(":")) {
    const file = join(path, bin);
    if (await access(file, constants.X_OK).then(() => true).catch(() => false)) return realpath(file);
  }
  throw new Error(`missing executable: ${bin}`);
}
export async function selectDriver(): Promise<{ driver: RuntimeDriver; kvm: boolean }> {
  if (!["auto", "docker", "firecracker"].includes(config.runtime)) throw new Error("TENDRIL_RUNTIME must be auto, docker, or firecracker");
  const kvm = process.platform === "linux" && await access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => true).catch(() => false);
  const hasVmState = async () => {
    const entries = await readdir(join(resolve(config.stateDir || "/var/lib/tendril"), "leases")).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    return entries.some((id) => /^tnd-[a-f0-9]{24}$/.test(id));
  };
  if (config.runtime === "docker") {
    if (await hasVmState()) throw new Error("unreconciled microVM leases; restore Firecracker prerequisites before switching to Docker");
    return { driver: dockerDriver(), kvm };
  }
  let driver: RuntimeDriver;
  try {
    if (!kvm || process.getuid?.() !== 0 || !["x64", "arm64"].includes(process.arch)) throw new Error("Linux root and usable /dev/kvm required");
    const jailer = await executable(config.jailerBin), firecracker = await executable(config.firecrackerBin);
    const version = async (bin: string) => (await command(bin, ["--version"])).stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1];
    const jv = await version(jailer), fv = await version(firecracker);
    if (!jv || jv !== fv) throw new Error("Firecracker/jailer version mismatch");
    const kernel = await realpath(config.guestKernel);
    const architecture = (await command("file", ["-b", kernel])).stdout;
    if (!(process.arch === "x64" ? /x86-64/i : /ARM aarch64|ARM64/i).test(architecture)) throw new Error("guest kernel architecture mismatch");
    if (!(await command("strings", [kernel], { maxBytes: 32_000_000 })).stdout.includes("-tendril")) throw new Error("guest kernel must use LOCALVERSION=-tendril");
    await command("python3", ["-c", "import os,fcntl; f=os.open('/dev/kvm',os.O_RDWR); assert fcntl.ioctl(f,0xae00,0)==12; os.close(f)"]);
    const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
    for (const required of ["cpu", "memory", "pids"]) if (!controllers.split(/\s+/).includes(required)) throw new Error(`cgroup v2 ${required} unavailable`);
    if (!/^[A-Za-z0-9_.\/-]+$/.test(config.cgroupParent) || config.cgroupParent.split("/").includes("..")) throw new Error("invalid cgroup parent");
    if (!Number.isSafeInteger(config.jailerUid) || !Number.isSafeInteger(config.jailerGid) || config.jailerUid <= 0 || config.jailerGid <= 0 ||
      !Number.isSafeInteger(config.vmmOverheadMib) || config.vmmOverheadMib < 64 || !Number.isSafeInteger(config.diskBytes) || config.diskBytes < 1024 ** 3) throw new Error("invalid guest identity or disk cap");
    if ((await readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim() !== "1") throw new Error("enable host IPv4 forwarding before starting");
    for (const bin of ["ip", "iptables", "sysctl", "cp", "tar", "truncate", "mkfs.ext4", "e2fsck", "debugfs", "ssh", "ssh-keygen", "docker"]) await executable(bin);
    const root = resolve(config.stateDir || "/var/lib/tendril");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await stat(root);
    if (info.uid !== 0 || (info.mode & 0o077) !== 0) throw new Error("state directory must be root-owned mode 0700");
    const template = await prepareRootfs(config.sandbox.image, join(root, "cache"), config.diskBytes);
    driver = firecrackerDriver({ kernelPath: kernel, jailerBin: jailer, firecrackerBin: firecracker, stateDir: root, template });
  } catch (err) {
    if (config.runtime === "firecracker") throw err;
    if (await hasVmState()) throw new Error("microVM preflight failed with unreconciled leases; restore prerequisites before startup");
    console.warn(`[agent] microVM preflight failed: ${(err as Error).message}; advertising legacy Docker`);
    return { driver: dockerDriver(), kvm };
  }
  // Failed recovery must prevent registration, including auto mode.
  await driver.reconcile?.();
  return { driver, kvm: true };
}
