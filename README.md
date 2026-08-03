# 🌿 Tendril — Contributor Agent

**Rent out your machine's CPU / RAM / GPU and get paid on-chain in USDC.**

This is the daemon a contributor runs. It registers your machine with a Tendril backend/registry,
heartbeats to stay listed, and when someone rents it, spins up a **hardened, ephemeral Docker SSH
sandbox** — torn down the moment the paid lease ends. Earnings are settled to your Algorand address
in USDC by the backend when the lease closes.

Standalone: it needs nothing from the rest of the Tendril monorepo, just a `REGISTRY_URL` to point
at.

## The trust model (why this is safe to run)

You give *compute*, never filesystem or account access. The safety boundary isn't a permissions
system — it's the container:

- **no host filesystem mounts** (`-v` is never used for a sandbox),
- **no inbound host ports** — the sandbox dials *out* over a [bore](https://github.com/ekzhang/bore)
  tunnel for SSH (in `TUNNEL_MODE=local` it publishes SSH only to `127.0.0.1`),
- nearly all Linux capabilities dropped (`--cap-drop ALL` plus only the handful sshd needs to let a
  root login in, `--security-opt no-new-privileges`),
- hard CPU / memory / PID caps (cgroups),
- `--rm`: **destroyed the moment the lease ends.**

Your private key never leaves this process. It signs a nonce to prove node ownership — nothing else.

## How it works

```
   Your PC (this agent)                       Backend / registry
 ┌───────────────────────────┐  WebSocket   ┌────────────────────────┐
 │ 1. sign nonce  → hello    │◄────────────►│ verifies the signature │
 │ 2. heartbeat every 10s    │              │ lists your node        │
 │ 3. start-container        │◄─────────────│ someone paid + rented  │
 │      docker run (hardened)│              │                        │
 │    → container-ready      │─────────────►│ hands renter host:port │
 │ 4. destroy-container      │◄─────────────│ lease ended            │
 └───────────┬───────────────┘              └────────────────────────┘
             │ bore tunnel (dials OUT)
             ▼
     the renter's SSH shell
```

| File | What it is |
|---|---|
| [src/index.ts](src/index.ts) | The daemon: connect, prove ownership, heartbeat, handle lease messages |
| [src/docker.ts](src/docker.ts) | Sandbox lifecycle — the hardened `docker run`, bore endpoint discovery, teardown |
| [src/config.ts](src/config.ts) | Every env var, in one place |
| [src/keys.ts](src/keys.ts) / [src/keygen.ts](src/keygen.ts) | Load a key / generate one |
| [src/specs.ts](src/specs.ts) | Detects the CPU / RAM / GPU this node advertises |
| [src/protocol.ts](src/protocol.ts) | The registry ↔ agent WebSocket contract (types + event names) |
| [sandbox-ssh/](sandbox-ssh/) | The sandbox image: sshd + python3 + bore, built locally on first rent |

## Prerequisites

- **Node 20+** and npm
- **Docker**, daemon running — the sandboxes are containers on your host
- A reachable **Tendril backend** (`REGISTRY_URL`)
- An **Algorand account** holding a little ALGO and **opted in to USDC** (testnet ASA `10458941`)
  — that's the address earnings are paid to. Opt in via the
  [asset dispenser](https://asset-dispenser.testnet.algorand.network/); the opt-in fee needs
  [testnet ALGO](https://bank.testnet.algorand.network/). Not opted in → payouts are recorded as
  unpaid and your node gets flagged `payoutBlocked`.
- Outbound network for the bore tunnel (nothing to open inbound)

## Quick start

```bash
npm install
npm run keygen                  # prints Address + AVM_PRIVATE_KEY

cp .env.example .env            # set AVM_PRIVATE_KEY, REGISTRY_URL, PRICE_PER_HOUR_USD
npm run dev                     # …or `npm run start` without file-watching
```

You should see:

```
[agent] owner=ABC…XYZ
[agent] specs: 8 CPU, 16384MB RAM, GPU=none
[agent] price: $1/hr -> paid to ABC…XYZ
[agent] registered as node n_… ; sending heartbeats
```

Your node is now listed in the backend's `/explorer` and rentable.

> The SSH sandbox image builds locally on the **first rent**, then is cached. That build compiles
> `bore` from source for your CPU arch (~30s), so the tunnel works on both x86_64 and arm64 — bore
> ships no arm64-linux binary. Later rents are instant.

Same machine as the renter? Set `TUNNEL_MODE=local` to skip bore and publish SSH to loopback.

## Run with Docker

```bash
cp .env.example .env            # set REGISTRY_URL + AVM_PRIVATE_KEY
docker compose up --build
```

The agent **doesn't run a Docker of its own**: it mounts the host Docker socket and launches each
sandbox as a sibling container on the host daemon, so there's nothing extra to install. In the
default `TUNNEL_MODE=bore` no inbound ports are needed. `network_mode: host` is only for
`TUNNEL_MODE=local` — and on Docker Desktop (Mac/Windows) host networking doesn't share the
loopback, so for local mode run the agent natively instead.

## Configuration

Everything is read from `.env` (see [.env.example](.env.example)); an inline
`FOO=bar npm run dev` overrides it.

| Variable | Default | What it does |
|---|---|---|
| `AVM_PRIVATE_KEY` | — | **Required.** Base64 64-byte Algorand key. Proves node ownership; its address receives earnings. |
| `REGISTRY_URL` | `http://localhost:4000` | The backend to register with. A bare host gets `http://` prepended. |
| `PAYTO_ADDR` | the signing address | Pay earnings somewhere else. |
| `NODE_LABEL` | `tendril-node` | Human label shown in the explorer. |
| `PRICE_PER_HOUR_USD` | `1.0` | Advertised hourly price. USDC has 6 decimals, so this × 1e6 is the atomic rate — no exchange rate to keep current. |
| `SANDBOX_IMAGE` | `tendril-ssh-sandbox:latest` | Left as the default it's built from `./sandbox-ssh`; set it and the image is yours to manage (never rebuilt). |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `2g` / `2` | Per-sandbox cgroup caps. A `--cpus` above the daemon's CPU count is clamped, not rejected. |
| `SANDBOX_GPUS` | *(empty)* | `all` to pass GPUs through (needs nvidia-container-toolkit). |
| `TUNNEL_MODE` | `bore` | `bore` = dial out (works anywhere); `local` = publish SSH to `127.0.0.1`. |
| `BORE_SERVER` | `bore.pub` | The public one is rate-limited/flaky — self-host `bore server` and point here. |
| `BORE_SECRET` | *(empty)* | Shared secret for a self-hosted `bore server --secret <s>`. |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Liveness ping interval. |

## Notes & limitations

- **The image is content-tagged.** The sandbox tag folds a hash of `sandbox-ssh/Dockerfile` +
  `entrypoint.sh` into it, so editing the entrypoint rebuilds exactly when it should — a `:latest`
  cached forever would silently keep starting containers built from the old script.
- **SSH auth** is a throwaway root container either way: a public key the renter sent
  (`authorized_keys`, root password locked) or, failing that, a per-lease password (their wallet
  address). Fine for ephemeral compute, but a password is a password.
- **Nothing is persisted.** Live leases are in memory; a restart drops them (the sockets die
  anyway). `SIGINT` destroys every sandbox on the way out.
- **Payouts are the backend's job.** This agent never touches money — it only advertises a price and
  a payout address. If the backend has no signing key, or your address never opted into USDC,
  earnings are recorded as unpaid instead.
- **Job execution** (`run-job`) pipes the payload to `python3` inside an existing lease's sandbox
  with a 120s timeout.
