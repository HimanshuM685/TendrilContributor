import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { dockerDriver, dockerEffects } from "./docker.js";
import type { LeaseRequest } from "./types.js";

const original = { ...dockerEffects };
const relay = { ssh: { controlHost: "s.control.example.com", controlPort: 9443, secret: "lease-secret",
  remotePort: 20000, publicHost: "lease.ssh.example.com", publicPort: 20000 } };
const request = (leaseId: string): LeaseRequest => ({ leaseId, image: "", limits: { memory: "2g", cpus: 2, gpus: "" },
  sshPassword: "renter-wallet", sshPubKey: null, surface: "ssh", relay, deadline: Date.now() + 5000 });
let keyDir = "", sshAttempts = 0, stops = 0;
dockerEffects.command = async (bin, args, opts) => {
  if (bin === "ssh-keygen") {
    keyDir = dirname(args[args.indexOf("-f") + 1]);
    return original.command(bin, args, opts);
  }
  if (bin === "docker") return { code: 0, stdout: "ssh-ed25519 AAAAfixture guest\n", stderr: "" };
  assert.equal(bin, "ssh");
  assert(args.includes("StrictHostKeyChecking=yes"));
  assert(args.includes("BatchMode=yes"));
  const hosts = args.find((a) => a.startsWith("UserKnownHostsFile="))!.split("=")[1];
  assert.equal(await readFile(hosts, "utf8"), "[lease.ssh.example.com]:20000 ssh-ed25519 AAAAfixture\n");
  if (++sshAttempts === 1) throw new Error("listener not ready yet");
  return { code: 0, stdout: "", stderr: "" };
};
dockerEffects.startSandbox = async (id, _image, _limits, password, keys, internal, allocation, signal) => {
  assert.equal(password, "renter-wallet");
  assert(keys?.startsWith("ssh-ed25519 "));
  assert.equal(internal, false);
  assert.equal(allocation, relay);
  signal?.throwIfAborted();
  return { leaseId: id, containerName: `tendril-${id}`, host: relay.ssh.publicHost, port: relay.ssh.publicPort };
};
dockerEffects.stopSandbox = async () => { stops++; };
try {
  const driver = dockerDriver();
  const start = driver.start(request("auth"));
  assert.throws(() => driver.exec("auth", "print(1)"), /not running/);
  const running = await start;
  assert.equal(sshAttempts, 2);
  assert.equal(running.access?.kind, "ssh");
  if (running.access?.kind === "ssh") assert.equal(running.access.password, "renter-wallet");
  const stop = driver.stop("auth");
  assert.equal(driver.stop("auth"), stop);
  await stop;
  assert.equal(stops, 1);
  assert.equal(await stat(keyDir).catch(() => null), null);
  await assert.rejects(driver.start(request("auth")), /destroyed/);

  let booting!: () => void;
  const entered = new Promise<void>((resolve) => { booting = resolve; });
  dockerEffects.startSandbox = async (_id, _image, _limits, _password, _keys, _internal, _relay, signal) => {
    booting();
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      if (signal!.aborted) reject(new Error("cancelled"));
    });
    throw new Error("unreachable");
  };
  const pending = driver.start(request("cancel"));
  const rejected = assert.rejects(pending, /cancelled/);
  await entered;
  await driver.stop("cancel");
  await rejected;
  assert.equal(await stat(keyDir).catch(() => null), null);

  dockerEffects.startSandbox = async (id) => ({ leaseId: id, containerName: `tendril-${id}`, host: "", port: 0 });
  await driver.start({ ...request("retry"), surface: "exec", relay: undefined });
  let attempts = 0;
  dockerEffects.stopSandbox = async () => { if (++attempts === 1) throw new Error("Docker unavailable"); };
  await assert.rejects(driver.stop("retry"), /unavailable/);
  await driver.stop("retry");
  assert.equal(attempts, 2);
  console.log("legacy Docker: authenticated relay readiness, cancellation, key cleanup and teardown retry ok");
} finally { Object.assign(dockerEffects, original); }
