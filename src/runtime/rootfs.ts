import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureImage } from "../docker.js";
import { command } from "./process.js";

export interface RootfsTemplate { image: string; disk: string; key: string; bytes: number }
const builds = new Map<string, Promise<RootfsTemplate>>();
export const rootfsEffects = { command, ensureImage };

/** Called during startup only. No lease calls Docker export. */
export function prepareRootfs(image: string, cache: string, bytes: number, signal?: AbortSignal): Promise<RootfsTemplate> {
  const buildKey = `${cache}:${image}:${bytes}`;
  const existing = builds.get(buildKey);
  if (existing) return existing;
  const build = buildTemplate(image, cache, bytes, signal).catch((err) => { builds.delete(buildKey); throw err; });
  builds.set(buildKey, build);
  return build;
}

async function buildTemplate(image: string, cache: string, bytes: number, signal?: AbortSignal): Promise<RootfsTemplate> {
  const tag = await rootfsEffects.ensureImage(image);
  const inspected = JSON.parse((await rootfsEffects.command("docker", ["image", "inspect", tag], { signal })).stdout)[0];
  const expected = process.arch === "arm64" ? "arm64" : "amd64";
  if (inspected.Architecture !== expected) throw new Error("OCI architecture does not match host");
  const key = createHash("sha256").update(`${inspected.Id}:guest-v2:${expected}:${bytes}`).digest("hex");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const disk = join(cache, `${key}.ext4`);
  if (await stat(disk).then((s) => s.size === bytes).catch(() => false)) return { image, disk, key, bytes };
  const stage = join(cache, `build-${randomUUID()}`);
  const extract = join(stage, "root");
  const name = `tendril-export-${randomUUID()}`;
  await mkdir(extract, { recursive: true, mode: 0o700 });
  try {
    await rootfsEffects.command("docker", ["create", "--name", name, tag], { signal });
    await rootfsEffects.command("docker", ["export", "--output", join(stage, "image.tar"), name], { signal, timeoutMs: 300_000 });
    await rootfsEffects.command("tar", ["-xf", join(stage, "image.tar"), "-C", extract], { signal, timeoutMs: 300_000 });
    for (const required of ["tendril-init.sh", "usr/local/bin/tendril-job", "usr/local/bin/jupyter"]) {
      if (!(await stat(join(extract, required)).catch(() => null))) throw new Error(`guest image missing ${required}`);
    }
    // SSH keys must be generated for each clone, never baked into the template.
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(join(extract, "etc/ssh"))) if (file.startsWith("ssh_host_")) await rm(join(extract, "etc/ssh", file));
    await mkdir(join(extract, "etc/tendril"), { recursive: true, mode: 0o700 });
    await mkdir(join(extract, "work"), { recursive: true });
    const built = join(stage, "rootfs.ext4");
    await rootfsEffects.command("truncate", ["-s", String(bytes), built], { signal });
    await rootfsEffects.command("mkfs.ext4", ["-q", "-F", "-d", extract, built], { signal, timeoutMs: 300_000 });
    await rootfsEffects.command("e2fsck", ["-fn", built], { signal });
    await chmod(built, 0o400);
    await rename(built, disk);
    return { image, disk, key, bytes };
  } finally {
    await rootfsEffects.command("docker", ["rm", "-f", name], { allowFailure: true }).catch(() => undefined);
    await rm(stage, { recursive: true, force: true });
  }
}

/** Reflink when supported, bounded sparse copy otherwise. Injection is offline. */
export async function cloneRootfs(template: RootfsTemplate, disk: string, files: Record<string, string>,
  uid: number, gid: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await mkdir(dirname(disk), { recursive: true, mode: 0o700 });
  await rootfsEffects.command("cp", ["--reflink=auto", "--sparse=auto", "--", template.disk, disk], { signal });
  await chmod(disk, 0o600);
  const stage = join(dirname(disk), `inject-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const [guestPath, contents] of Object.entries(files)) {
      if (!/^\/(etc\/tendril|etc\/ssh)\/[A-Za-z0-9_.-]+$/.test(guestPath)) throw new Error("invalid guest injection path");
      const source = join(stage, randomUUID());
      await writeFile(source, contents, { mode: 0o600 });
      const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const wrote = await rootfsEffects.command("debugfs", ["-w", "-R", `write ${quote(source)} ${quote(guestPath)}`, disk], { signal });
      if (/not found|error|already exists|could not|no space/i.test(wrote.stderr)) throw new Error("guest disk injection failed");
      await rootfsEffects.command("debugfs", ["-w", "-R", `set_inode_field ${guestPath} mode 0100600`, disk], { signal });
      const verify = await rootfsEffects.command("debugfs", ["-R", `cat ${guestPath}`, disk], { signal });
      if (verify.stdout !== contents) throw new Error("guest disk injection verification failed");
    }
    if ((await stat(disk)).size !== template.bytes) throw new Error("rootfs size changed");
    // This changes the backing inode only, not ownership inside ext4.
    await chown(disk, uid, gid);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
