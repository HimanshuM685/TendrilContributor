/**
 * Firecracker config and cleanup, without booting a VM.
 * Run: npx tsx contributor/src/runtime/firecracker.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { advertise } from "./select.js";
import { buildBootConfig, jailerArgv, removeLeaseDir, vmId, memoryMib } from "./firecracker.js";

const kernel = "/opt/tendril/guest-vmlinux";
const cfg = buildBootConfig({
  kernelPath: kernel,
  rootfsPath: "/tmp/lease/rootfs.ext4",
  tap: "tnd1",
  guestMac: "06:00:0a:c8:00:02",
  vcpus: 2,
  memMib: 2048,
  guestIp: "10.200.0.2",
  hostIp: "10.200.0.1",
});
const boot = cfg["boot-source"] as { kernel_image_path: string };
assert.equal(boot.kernel_image_path, kernel);

const argv = jailerArgv({
  jailer: "jailer",
  firecracker: "/usr/bin/firecracker",
  id: "lease1",
  uid: 123,
  gid: 123,
  chrootBase: "/var/lib/tendril/jail",
});
assert.equal(argv[0], "jailer");
assert.equal(argv.includes("--bind"), false);
assert.equal(argv.includes("--gpus"), false);
assert.equal(argv.includes("-p"), false);
assert.equal(argv.join(" ").includes("/dev"), false);
assert.equal(argv.includes("--no-seccomp"), false);
assert.ok(argv.includes("cpu.max=100000 100000"));
assert.ok(argv.includes("memory.max=2281701376"));
assert.ok(argv.includes("pids.max=256"));
assert.match(vmId("_../lease"), /^[A-Za-z0-9-]+$/);
assert.notEqual(vmId("lease_a"), vmId("lease-a"));
assert.equal(memoryMib("2g"), 2048);
assert.throws(() => memoryMib("unlimited"));

const dir = await mkdtemp(join(tmpdir(), "tendril-lease-"));
await writeFile(join(dir, "rootfs.ext4"), "disk");
await removeLeaseDir(dir);
assert.equal(existsSync(dir), false);

assert.deepEqual(advertise({ kvmDevice: false, canBootMicrovm: false }), { runtime: "docker", kvm: false });
assert.deepEqual(advertise({ kvmDevice: false, canBootMicrovm: true }), { runtime: "docker", kvm: false });
assert.deepEqual(advertise({ kvmDevice: true, canBootMicrovm: false }), { runtime: "docker", kvm: true });
assert.deepEqual(advertise({ kvmDevice: true, canBootMicrovm: true }), { runtime: "microvm", kvm: true });

console.log("firecracker driver checks ok");
