# 🌿 Tendril — Contributor Agent

**Rent out your Linux machine's CPU / RAM and get paid in USDC.**

This is the daemon a contributor runs. It registers your machine with the Tendril registry,
heartbeats to stay listed, and when someone rents it, boots a **jailed Firecracker microVM** from
the sandbox image (own guest kernel, SSH + Jupyter inside) — destroyed the moment the paid lease
ends. Hosts without KVM fall back to a hardened legacy Docker sandbox (SSH/Python only).

Each closed lease credits your **earnings balance** (after the platform fee), and you withdraw that
balance to your wallet from the web app.

**Linux only.** Firecracker needs `/dev/kvm`; macOS and Windows hosts are not supported.

Standalone: it needs nothing from the rest of the Tendril monorepo, and nothing but an API key to
configure.

## The trust model (why this is safe to run)

You give *compute*, never filesystem or account access. With Firecracker the boundary is a
**microVM**: separate guest kernel, `jailer` chroot + unprivileged UID, cgroup CPU/memory/PID caps,
fixed-size ext4 clone of a cached template, private netns/TAP per lease. Legacy Docker uses the
container:

- **no host filesystem mounts** (`-v` is never used for a sandbox),
- **no inbound host ports** — the sandbox dials *out* over a [bore](https://github.com/ekzhang/bore)
  tunnel for SSH (in `TUNNEL_MODE=local` it publishes SSH only to `127.0.0.1`),
- nearly all Linux capabilities dropped (`--cap-drop ALL` plus only the handful sshd needs to let a
  root login in, `--security-opt no-new-privileges`),
- hard CPU / memory / PID caps (cgroups),
- `--rm`: **destroyed the moment the lease ends.**

**This machine holds no wallet key.** It authenticates with an API key you mint in the web app; the
wallet that minted it owns the node and receives the earnings. Losing the key costs you a node
registration, not funds — revoke it in the web app and mint another.

## How it works

```
   Your PC (this agent)                       Backend / registry
 ┌───────────────────────────┐  WebSocket   ┌────────────────────────┐
 │ 1. API key     → hello    │◄────────────►│ resolves it to your    │
 │                           │              │ wallet, lists the node │
 │ 2. heartbeat every 10s    │              │                        │
 │ 3. start-container        │◄─────────────│ someone paid + rented  │
 │      docker run (hardened)│              │                        │
 │    → container-ready      │─────────────►│ hands renter host:port │
 │ 4. destroy-container      │◄─────────────│ lease ended → you earn │
 └───────────┬───────────────┘              └────────────────────────┘
             │ bore tunnel (dials OUT)
             ▼
     the renter's SSH shell
```

| File | What it is |
|---|---|
| [src/index.ts](src/index.ts) | The daemon: connect, authenticate, heartbeat, handle lease messages |
| [src/runtime/select.ts](src/runtime/select.ts) | Picks Firecracker or legacy Docker (`TENDRIL_RUNTIME`), runs the KVM/kernel/cgroup preflight |
| [src/runtime/firecracker.ts](src/runtime/firecracker.ts) | MicroVM lifecycle: rootfs clone, jailer boot, SSH readiness, teardown, orphan reconcile |
| [src/runtime/network.ts](src/runtime/network.ts) · [rootfs.ts](src/runtime/rootfs.ts) | Per-lease netns/TAP/NAT · OCI image → cached ext4 template |
| [src/docker.ts](src/docker.ts) | Legacy sandbox lifecycle — the hardened `docker run`, teardown |
| [src/config.ts](src/config.ts) | Every env var, in one place |
| [src/specs.ts](src/specs.ts) | Detects the CPU / RAM / GPU this node advertises |
| [src/protocol.ts](src/protocol.ts) | The registry ↔ agent WebSocket contract (types + event names) |
| [sandbox-ssh/](sandbox-ssh/) | Guest userspace: init, sshd, Jupyter, job runner, TLS relay tunnel |
| [docker-entrypoint.sh](docker-entrypoint.sh) | Nests the agent's cgroup so VMMs die with the container |
| [scripts/build-kernel.sh](scripts/build-kernel.sh) | Builds the pinned guest kernel (Linux v6.1.128, `-tendril`) |

## Prerequisites

- **Linux** x86_64 or aarch64 with writable `/dev/kvm` and cgroup v2 (see below)
- **Docker** + Compose v2 — packages the agent and the guest image
- A **Tendril API key** — connect your wallet in the web app, sign in, open **CONTRIBUTE**, and
  click **MINT API KEY**. It's shown once.
- Outbound network for the bore tunnel (nothing to open inbound)

To *withdraw* what you earn, the same wallet must be opted in to USDC (testnet ASA `10458941`) —
but only at withdrawal time. Earnings accrue either way.

## Quick start

Do the one-time [host prep](#1-host-prep-once), then:

```bash
cp .env.example .env            # paste TENDRIL_API_KEY, set NODE_LABEL + PRICE_PER_HOUR_USD
docker compose up -d --build
docker compose logs -f          # [agent] n_… runtime=microvm kvm=true
```

Your node is now listed in the explorer and rentable. (Native alternative: `sudo npm run start`
with the same env — Firecracker needs root.)

> The guest image and its ext4 template build once at **startup**, before the node registers. That
> build compiles `bore` from source for your CPU arch, so the tunnel works on x86_64 and arm64.
> Each rent then only copies the template and boots.

Same machine as the renter? Set `TUNNEL_MODE=local` to skip bore and publish SSH to loopback.

## Firecracker (Linux)

### 1. Host prep (once)

```bash
sudo apt-get install -y git build-essential flex bison bc libelf-dev libssl-dev
sudo modprobe kvm_intel || sudo modprobe kvm_amd; sudo modprobe tun
test -w /dev/kvm && grep -qw memory /sys/fs/cgroup/cgroup.controllers && echo ok
echo net.ipv4.ip_forward=1 | sudo tee /etc/sysctl.d/99-tendril.conf && sudo sysctl --system
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tendril-vmm
sudo install -d -m 0700 -o root -g root /var/lib/tendril /opt/tendril-kernel
sudo KERNEL_OUTPUT=/opt/tendril-kernel/vmlinux sh scripts/build-kernel.sh   # ~10–20 min
cp .env.example .env   # TENDRIL_API_KEY, JAILER_UID=$(id -u tendril-vmm), JAILER_GID=$(id -g tendril-vmm)
```

Firecracker + jailer **v1.12.1** ship inside the agent image (checksum-pinned). The kernel stays on
the host and is mounted read-only.

### 2. Run it like a daemon

```bash
docker compose up -d --build      # preflight → reconcile orphans → build rootfs template → register
docker compose logs -f            # "[agent] n_… runtime=microvm kvm=true"
docker compose restart            # reconcile runs before re-registering
docker compose down               # SIGTERM destroys every guest, then the container exits
```

Lifecycle: the agent stays registered while up; **microVMs exist only for a live lease**. A lease
boots one VM; release, the billing watchdog, a registry disconnect or agent shutdown destroys it
(VMM, disk clone, keys, netns, NAT rules). Zero VMs while idle. `docker-entrypoint.sh` puts every
VMM inside the container's cgroup, so even `docker kill` or a crash leaves nothing running; leftover
host iptables rules and jail dirs are removed by reconcile on the next `up` (state lives in
`/var/lib/tendril`). `TENDRIL_RUNTIME=firecracker` (compose default) refuses to start rather than
silently fall back to Docker; set `auto` to allow fallback.

### 3. How SSH reaches each guest

1. Registry sends `start-container` with a per-lease relay allocation (`relay.ssh`).
2. Agent clones the cached ext4 template and injects `/etc/tendril/lease.json` + a fresh SSH host
   key offline (`debugfs`), then `jailer` boots Firecracker in netns `tnd-…`
   (TAP `10.200.0.1/30` ↔ guest `10.200.0.2`, uplink veth `10.201.x.x` with NAT).
3. In the guest, `tendril-guest` starts sshd (and Jupyter) and dials **out** through the TLS bore
   relay. The renter gets `ssh root@<lease>.ssh.<domain> -p <port>` with a pinned host key.
4. The agent reaches the guest only over the private TAP (`ip netns exec tnd-… ssh root@10.200.0.2`)
   to confirm the guest kernel (`uname -r` ends in `-tendril`) and to run `run-job` payloads.

The backend you register with must run the relay manager (`RELAY_SOCKET`); without it SSH leases
fail with `SSH relay allocation missing`.

### 4. Verify

```bash
npm install && npm run typecheck && npm test                       # unit checks, no KVM needed
docker run --rm --entrypoint firecracker tendril-contributor --version   # v1.12.1
CG=$(docker inspect -f '{{.Id}}' $(docker compose ps -q contributor))
ls /sys/fs/cgroup/system.slice/docker-$CG.scope/vms               # empty while idle
# rent from the web UI, SSH in: uname -r → …-tendril
pgrep -c firecracker                                               # 1 per live lease
# release the lease, then:
PID=$(docker inspect -f '{{.State.Pid}}' $(docker compose ps -q contributor))
pgrep -c firecracker; sudo nsenter -t $PID -m ip netns; sudo ls /var/lib/tendril/leases   # 0 / empty / empty
# crash path: rent, then
docker kill $(docker compose ps -q contributor); pgrep -c firecracker   # 0
docker compose up -d; sudo iptables -S | grep -c tnd-                  # 0 after reconcile
```

## Getting paid

1. Leases you serve credit your **earnings balance**, post-fee, when each one closes.
2. Open **CONTRIBUTE** in the web app with the wallet that minted your key to see the balance.
3. **WITHDRAW** sends the whole balance to that wallet in one on-chain transfer.

There is a **$5 minimum withdrawal**. One transfer costs the same whether it moves five dollars or
five cents, so the balance accrues instead of trickling out as dust.

## Configuration

Everything is read from `.env` (see [.env.example](.env.example)); an inline
`FOO=bar npm run dev` overrides it.

| Variable | Default | What it does |
|---|---|---|
| `TENDRIL_API_KEY` | — | **Required.** Minted in the web app. Identifies the node and names the wallet that earns for it. |
| `NODE_LABEL` | `tendril-node` | Human label shown in the explorer. |
| `PRICE_PER_HOUR_USD` | `1.0` | Advertised hourly price. USDC has 6 decimals, so this × 1e6 is the atomic rate — no exchange rate to keep current. |
| `SANDBOX_IMAGE` | `tendril-ssh-sandbox:latest` | Left as the default it's built from `./sandbox-ssh`; set it and the image is yours to manage (never rebuilt). |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `2g` / `2` | Per-sandbox cgroup caps. A `--cpus` above the daemon's CPU count is clamped, not rejected. |
| `SANDBOX_GPUS` | *(empty)* | Legacy Docker only: `all` passes GPUs through (needs nvidia-container-toolkit). MicroVMs get no GPU. |
| `TUNNEL_MODE` | `bore` | `bore` = dial out (works anywhere); `local` = publish SSH to `127.0.0.1`. |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Liveness ping interval. |
| `TENDRIL_RUNTIME` | `firecracker` (compose) / `auto` | `firecracker` fails startup without KVM; `auto` falls back to legacy Docker; `docker` forces legacy. |
| `GUEST_KERNEL` | `/opt/tendril-kernel/vmlinux` (compose) | Guest kernel from `scripts/build-kernel.sh`. |
| `JAILER_UID` / `JAILER_GID` | `123` | Unprivileged identity the VMM runs as (`tendril-vmm`). |
| `GUEST_DISK_BYTES` | `4294967296` | Fixed guest disk size. |
| `VMM_OVERHEAD_MIB` | `128` | Extra memory cap per VMM above guest RAM. |
| `GUEST_DNS` | `1.1.1.1` | Resolver written into the guest. |
| `REGISTRY_URL` | the hosted registry | Only for self-hosting the backend. A bare host gets `http://` prepended. |

The bore server and its secret are **not** configured here — the registry sends them in the hello
ack, so the platform can move every node at once.

## Notes & limitations

- **The image is content-tagged.** The sandbox tag folds a hash of `sandbox-ssh/Dockerfile` +
  `entrypoint.sh` into it, so editing the entrypoint rebuilds exactly when it should — a `:latest`
  cached forever would silently keep starting containers built from the old script.
- **SSH auth** is a throwaway root container either way: a public key the renter sent
  (`authorized_keys`, root password locked) or, failing that, a per-lease password (their wallet
  address). Fine for ephemeral compute, but a password is a password.
- **Only cleanup state is persisted.** Lease manifests in `/var/lib/tendril/leases` let a restart
  reconcile (kill + delete) anything a crash left behind before the node re-registers. `SIGINT` /
  `SIGTERM` destroy every guest on the way out.
- **Money is the backend's job.** This agent never touches funds — it advertises a price, and the
  backend credits your balance when a lease closes.
- **Job execution** (`run-job`) runs `tendril-job` inside an existing lease's guest over the
  private TAP (legacy: `docker exec python3`), bounded by the lease's job deadline.
