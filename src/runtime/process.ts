import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface CommandResult { code: number; stdout: string; stderr: string }
export async function command(bin: string, args: string[], opts: {
  signal?: AbortSignal; input?: string; timeoutMs?: number; allowFailure?: boolean; maxBytes?: number;
} = {}): Promise<CommandResult> {
  opts.signal?.throwIfAborted();
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform === "linux" });
  let stdout = "", stderr = "", overflow = false;
  const max = opts.maxBytes ?? 4_000_000;
  const kill = () => killGroup(child, "SIGKILL");
  opts.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, opts.timeoutMs ?? 120_000);
  child.stdout.on("data", (d: Buffer) => { if (stdout.length + d.length > max) { overflow = true; kill(); } else stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-64_000); });
  child.stdin.on("error", () => undefined);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input);
  }).finally(() => { clearTimeout(timer); opts.signal?.removeEventListener("abort", kill); });
  opts.signal?.throwIfAborted();
  if (overflow) throw new Error(`${bin}: output limit exceeded`);
  if (result.code !== 0 && !opts.allowFailure) throw new Error(`${bin} failed (${result.code}): ${result.stderr.slice(-2000)}`);
  return result;
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(process.platform === "linux" ? -child.pid : child.pid, signal); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
}

export async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
  killGroup(child, "SIGTERM");
  await Promise.race([done, delay(500)]);
  if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
  await Promise.race([done, delay(5000).then(() => { throw new Error("process did not exit"); })]);
}
