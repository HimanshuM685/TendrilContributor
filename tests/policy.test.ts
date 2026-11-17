import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveLimits, imageAllowed, parseMemory } from "../src/docker.js";

const ceilings = { image: "tendril-ssh-sandbox:latest", allowedImages: ["ghcr.io/acme/cuda:12.4"], memory: "2g", cpus: 2, gpus: "" };

test("parseMemory understands docker size strings", () => {
  assert.equal(parseMemory("2g"), 2 * 1024 ** 3);
  assert.equal(parseMemory("512m"), 512 * 1024 ** 2);
  assert.equal(parseMemory("1024k"), 1024 * 1024);
  assert.equal(parseMemory("4GiB"), 4 * 1024 ** 3);
  assert.equal(parseMemory("100"), 100);
  assert.throws(() => parseMemory("lots"));
  assert.throws(() => parseMemory("2g; rm -rf /"));
});

test("effectiveLimits never exceeds the operator's ceilings or the daemon", () => {
  assert.deepEqual(effectiveLimits({ memory: "8g", cpus: 16, gpus: "all" }, 8, ceilings), { memory: "2g", cpus: 2, gpus: "" });
  assert.deepEqual(effectiveLimits({ memory: "512m", cpus: 1, gpus: "" }, 8, ceilings), { memory: "512m", cpus: 1, gpus: "" });
  // Daemon has fewer CPUs than the operator configured.
  assert.equal(effectiveLimits({ cpus: 2 }, 1, ceilings).cpus, 1);
  // GPU only when the operator opted in AND the lease asks for it.
  assert.equal(effectiveLimits({ gpus: "all" }, 8, { ...ceilings, gpus: "all" }).gpus, "all");
  assert.equal(effectiveLimits({ gpus: "" }, 8, { ...ceilings, gpus: "all" }).gpus, "");
  // Missing fields fall back to the ceilings themselves.
  assert.deepEqual(effectiveLimits({}, 0, ceilings), { memory: "2g", cpus: 2, gpus: "" });
});

test("imageAllowed accepts only configured images with a sane reference", () => {
  assert.equal(imageAllowed("tendril-ssh-sandbox:latest", ceilings), true);
  assert.equal(imageAllowed("ghcr.io/acme/cuda:12.4", ceilings), true);
  assert.equal(imageAllowed("ubuntu:latest", ceilings), false);
  assert.equal(imageAllowed("--privileged", ceilings), false);
  assert.equal(imageAllowed("-v/:/host", ceilings), false);
  assert.equal(imageAllowed("", ceilings), false);
  assert.equal(imageAllowed("tendril-ssh-sandbox:latest --privileged", ceilings), false);
});
