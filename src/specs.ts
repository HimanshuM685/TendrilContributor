import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Detect this machine's advertised compute specs. */
export async function detectSpecs(): Promise<{
  cpuCores: number;
  ramMb: number;
  gpu: string | null;
}> {
  const cpuCores = os.cpus().length;
  const ramMb = Math.round(os.totalmem() / (1024 * 1024));
  const gpu = await detectGpu();
  return { cpuCores, ramMb, gpu };
}

/** Best-effort GPU detection via nvidia-smi; null if unavailable. */
async function detectGpu(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("nvidia-smi", [
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    const name = stdout.split("\n")[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}
