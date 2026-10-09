import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { config } from "../config.js";
import { selectDriver } from "./select.js";
if (process.platform !== "linux" || !await access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => true).catch(() => false)) {
  config.runtime = "auto";
  const selected = await selectDriver();
  assert.equal(selected.driver.kind, "docker"); assert.equal(selected.kvm, false);
  assert.equal(selected.driver.capabilities.notebook, false);
  config.runtime = "firecracker";
  await assert.rejects(selectDriver(), /usable \/dev\/kvm/);
  const original = config.stateDir;
  const state = await mkdtemp(join(tmpdir(), "tendril-select-"));
  try {
    config.stateDir = state;
    await mkdir(join(state, "leases", "tnd-" + "a".repeat(24)), { recursive: true });
    config.runtime = "auto";
    await assert.rejects(selectDriver(), /unreconciled leases/);
    config.runtime = "docker";
    await assert.rejects(selectDriver(), /unreconciled microVM leases/);
  } finally { config.stateDir = original; await rm(state, { recursive: true, force: true }); }
  console.log("no-KVM selection: legacy only; explicit Firecracker and unreconciled VM state refuse startup");
} else console.log("no-KVM selection skipped on KVM runner (advertisement matrix still tested)");
