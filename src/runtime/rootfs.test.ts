import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRootfs, rootfsEffects } from "./rootfs.js";
const root = await mkdtemp(join(tmpdir(), "tendril-cache-test-"));
const original = { ...rootfsEffects };
let exports = 0, removes = 0, failExport = false;
rootfsEffects.ensureImage = async (image) => image;
rootfsEffects.command = async (bin, args) => {
  if (bin === "docker" && args[0] === "image") return { code: 0, stdout: JSON.stringify([{ Id: args[2], Architecture: process.arch === "arm64" ? "arm64" : "amd64" }]), stderr: "" };
  if (bin === "docker" && args[0] === "export") { exports++; if (failExport) throw new Error("export exited nonzero"); }
  if (bin === "docker" && args[0] === "rm") removes++;
  if (bin === "tar") {
    const dir = args[3]; await mkdir(join(dir, "etc/ssh"), { recursive: true }); await mkdir(join(dir, "usr/local/bin"), { recursive: true });
    for (const file of ["tendril-init.sh", "usr/local/bin/tendril-job", "usr/local/bin/jupyter"]) await writeFile(join(dir, file), "fixture");
  }
  if (bin === "truncate") await writeFile(args[2], Buffer.alloc(Number(args[1])));
  return { code: 0, stdout: "", stderr: "" };
};
try {
  const cache = join(root, "cache");
  const [a, b] = await Promise.all([prepareRootfs("image-a", cache, 1024), prepareRootfs("image-a", cache, 1024)]);
  assert.equal(a.disk, b.disk); assert.equal(exports, 1); assert.equal(removes, 1);
  await prepareRootfs("image-a", cache, 1024); assert.equal(exports, 1);
  const changed = await prepareRootfs("image-b", cache, 1024); assert.notEqual(changed.key, a.key); assert.equal(exports, 2);
  failExport = true;
  await assert.rejects(prepareRootfs("failed-image", cache, 1024), /export exited/);
  assert.equal(removes, 3); assert.equal((await readdir(cache)).length, 2, "failed export must leave no staging/template");
  assert.equal((await readdir(cache)).some((f) => f.startsWith("build-")), false);
  console.log("rootfs cache: startup-only export, concurrent build, content identity and failure cleanup ok");
} finally { Object.assign(rootfsEffects, original); await rm(root, { recursive: true, force: true }); }
