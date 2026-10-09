import { command } from "./process.js";

export interface GuestNetwork { namespace: string; tap: string; hostDev: string; peerDev: string; hostIp: string; peerIp: string; guestIp: string; gateway: string; index: number }
export function networkFor(id: string, index: number): GuestNetwork {
  const third = Math.floor(index / 64), fourth = index % 64 * 4;
  return { namespace: id, tap: "tap0", hostDev: `th${id.slice(-10)}`, peerDev: `tn${id.slice(-10)}`,
    hostIp: `10.201.${third}.${fourth + 1}`, peerIp: `10.201.${third}.${fourth + 2}`,
    guestIp: "10.200.0.2", gateway: "10.200.0.1", index };
}
async function rule(table: string, chain: string, args: string[], add: boolean) {
  const prefix = ["-w", "5", "-t", table];
  const found = await command("iptables", [...prefix, "-C", chain, ...args], { allowFailure: true });
  if (found.code !== 0 && found.code !== 1) throw new Error(`iptables check failed: ${found.stderr}`);
  if ((found.code === 0) === add) return;
  await command("iptables", [...prefix, add ? "-A" : "-D", chain, ...args]);
}
function hostRules(n: GuestNetwork): [string, string, string[]][] {
  return [
    ["nat", "POSTROUTING", ["-s", `${n.peerIp}/32`, "-m", "comment", "--comment", n.namespace, "-j", "MASQUERADE"]],
    ["filter", "FORWARD", ["-i", n.hostDev, "-m", "comment", "--comment", n.namespace, "-j", "ACCEPT"]],
    ["filter", "FORWARD", ["-o", n.hostDev, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", n.namespace, "-j", "ACCEPT"]],
  ];
}
export async function createNetwork(n: GuestNetwork, uid: number, signal: AbortSignal) {
  const run = (args: string[]) => command("ip", args, { signal });
  await run(["netns", "add", n.namespace]);
  await run(["link", "add", n.hostDev, "type", "veth", "peer", "name", n.peerDev]);
  await run(["link", "set", n.peerDev, "netns", n.namespace]);
  await run(["addr", "add", `${n.hostIp}/30`, "dev", n.hostDev]);
  await run(["link", "set", n.hostDev, "up"]);
  const ns = (args: string[]) => run(["-n", n.namespace, ...args]);
  await ns(["addr", "add", `${n.peerIp}/30`, "dev", n.peerDev]);
  await ns(["link", "set", n.peerDev, "up"]);
  await ns(["link", "set", "lo", "up"]);
  await ns(["route", "add", "default", "via", n.hostIp]);
  await run(["netns", "exec", n.namespace, "ip", "tuntap", "add", "dev", n.tap, "mode", "tap", "user", String(uid)]);
  await ns(["addr", "add", `${n.gateway}/30`, "dev", n.tap]);
  await ns(["link", "set", n.tap, "up"]);
  await run(["netns", "exec", n.namespace, "sysctl", "-w", "net.ipv4.ip_forward=1"]);
  await run(["netns", "exec", n.namespace, "iptables", "-t", "nat", "-A", "POSTROUTING", "-o", n.peerDev, "-j", "MASQUERADE"]);
  await run(["netns", "exec", n.namespace, "iptables", "-P", "FORWARD", "DROP"]);
  await run(["netns", "exec", n.namespace, "iptables", "-A", "FORWARD", "-i", n.tap, "-o", n.peerDev, "-j", "ACCEPT"]);
  await run(["netns", "exec", n.namespace, "iptables", "-A", "FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"]);
  for (const [table, chain, args] of hostRules(n)) { signal.throwIfAborted(); await rule(table, chain, args, true); }
}
export async function removeNetwork(n: GuestNetwork) {
  for (const [table, chain, args] of hostRules(n).reverse()) await rule(table, chain, args, false);
  const namespaces = (await command("ip", ["netns", "list"])).stdout;
  if (namespaces.split("\n").some((line) => line.split(" ")[0] === n.namespace)) await command("ip", ["netns", "delete", n.namespace]);
  const links = JSON.parse((await command("ip", ["-j", "link", "show"])).stdout) as { ifname: string }[];
  if (links.some((l) => l.ifname === n.hostDev)) await command("ip", ["link", "delete", n.hostDev]);
}
