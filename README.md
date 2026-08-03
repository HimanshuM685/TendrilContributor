# 🌿 Tendril — Contributor Agent

**Rent out your machine's CPU / RAM / GPU and get paid in USDC.**

This is the daemon a contributor runs. It registers your machine with the Tendril registry,
heartbeats to stay listed, and when someone rents it, spins up a **hardened, ephemeral Docker SSH
sandbox** — torn down the moment the paid lease ends. Each closed lease credits your **earnings
balance** (after the platform fee), and you withdraw that balance to your wallet from the web app.

Standalone: it needs nothing from the rest of the Tendril monorepo, and nothing but an API key to
configure.

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
| [src/docker.ts](src/docker.ts) | Sandbox lifecycle — the hardened `docker run`, bore endpoint discovery, teardown |
| [src/config.ts](src/config.ts) | Every env var, in one place |
| [src/specs.ts](src/specs.ts) | Detects the CPU / RAM / GPU this node advertises |
| [src/protocol.ts](src/protocol.ts) | The registry ↔ agent WebSocket contract (types + event names) |
| [sandbox-ssh/](sandbox-ssh/) | The sandbox image: sshd + python3 + bore, built locally on first rent |

## Prerequisites

- **Node 20+** and npm
- **Docker**, daemon running — the sandboxes are containers on your host
- A **Tendril API key** — connect your wallet in the web app, sign in, open **CONTRIBUTE**, and
  click **MINT API KEY**. It's shown once.
- Outbound network for the bore tunnel (nothing to open inbound)

To *withdraw* what you earn, the same wallet must be opted in to USDC (testnet ASA `10458941`) —
but only at withdrawal time. Earnings accrue either way.

## Quick start

```bash
npm install
cp .env.example .env            # paste TENDRIL_API_KEY, set NODE_LABEL + PRICE_PER_HOUR_USD
npm run dev                     # …or `npm run start` without file-watching
```

You should see:

```
[agent] registry: https://tendrilregister.007575.xyz
[agent] specs: 8 CPU, 16384MB RAM, GPU=none
[agent] price: $1/hr
[agent] registered as node n_… ; earnings go to ABC…XYZ
```

Your node is now listed in the explorer and rentable.

> The SSH sandbox image builds locally on the **first rent**, then is cached. That build compiles
> `bore` from source for your CPU arch (~30s), so the tunnel works on both x86_64 and arm64 — bore
> ships no arm64-linux binary. Later rents are instant.

Same machine as the renter? Set `TUNNEL_MODE=local` to skip bore and publish SSH to loopback.

## Run with Docker

```bash
cp .env.example .env            # paste TENDRIL_API_KEY
docker compose up --build
```

The agent **doesn't run a Docker of its own**: it mounts the host Docker socket and launches each
sandbox as a sibling container on the host daemon, so there's nothing extra to install. In the
default `TUNNEL_MODE=bore` no inbound ports are needed. `network_mode: host` is only for
`TUNNEL_MODE=local` — and on Docker Desktop (Mac/Windows) host networking doesn't share the
loopback, so for local mode run the agent natively instead.

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
| `SANDBOX_GPUS` | *(empty)* | `all` to pass GPUs through (needs nvidia-container-toolkit). |
| `TUNNEL_MODE` | `bore` | `bore` = dial out (works anywhere); `local` = publish SSH to `127.0.0.1`. |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Liveness ping interval. |
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
- **Nothing is persisted.** Live leases are in memory; a restart drops them (the sockets die
  anyway). `SIGINT` destroys every sandbox on the way out.
- **Money is the backend's job.** This agent never touches funds — it advertises a price, and the
  backend credits your balance when a lease closes.
- **Job execution** (`run-job`) pipes the payload to `python3` inside an existing lease's sandbox
  with a 120s timeout.
