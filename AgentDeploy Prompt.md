# AgentDeploy Prompt — Deploy the Tendril contributor worker

You are deploying **this repo** as a contributor agent: a daemon that registers the host, heartbeats, and on a paid lease starts a hardened ephemeral Docker SSH sandbox. Earnings go to the wallet that minted `TENDRIL_API_KEY`. This machine holds **no wallet key**.

If `.env` has no `TENDRIL_API_KEY`, stop and run `Setup Prompt.md` first.

## Goal

Node registered with the registry and staying listed. Success log:

```
[agent] registry: https://tendrilregister.007575.xyz
[agent] specs: … CPU, …MB RAM, GPU=…
[agent] price: $…/hr
[agent] registered as node n_… ; earnings go to …
```

## What this agent is

```
Your PC (this agent)                       Backend / registry
┌───────────────────────────┐  WebSocket   ┌────────────────────────┐
│ 1. API key     → hello    │◄────────────►│ resolves it to wallet  │
│ 2. heartbeat every 10s    │              │ lists the node         │
│ 3. start-container        │◄─────────────│ paid lease             │
│      docker run (hardened)│              │                        │
│    → container-ready      │─────────────►│ renter host:port       │
│ 4. destroy-container      │◄─────────────│ lease end → earnings   │
└───────────┬───────────────┘              └────────────────────────┘
            │ bore tunnel (dials OUT)
            ▼
     the renter's SSH shell
```

Sandboxes: no host filesystem mounts, no inbound host ports (bore dials out), `--cap-drop ALL`, cgroup caps, `--rm` on lease end.

## Prerequisites (verify, do not skip)

1. **Node 20+** and npm — only needed for native run (`npm run dev` / `npm run start`).
2. **Docker daemon running** on the host. Sandboxes are containers on **this** daemon.
3. **`.env` with `TENDRIL_API_KEY`** from `Setup Prompt.md`.
4. Outbound network (bore). Nothing to open inbound in default `TUNNEL_MODE=bore`.

```bash
node -v          # >= 20
docker info      # daemon reachable
test -n "$(grep -E '^TENDRIL_API_KEY=tnd_' .env)" || echo "MISSING KEY"
```

## Configure

From repo root:

```bash
test -f .env || cp .env.example .env
```

| Variable | Default | Required |
|---|---|---|
| `TENDRIL_API_KEY` | — | **Yes.** `tnd_…` from `POST /keys`. |
| `NODE_LABEL` | `tendril-node` | Human name in the explorer. |
| `PRICE_PER_HOUR_USD` | `1.0` | Advertised hourly USD. × 1e6 = atomic USDC rate. |
| `SANDBOX_IMAGE` | `tendril-ssh-sandbox:latest` | Leave default → built from `./sandbox-ssh` on first rent. |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `2g` / `2` | Per-sandbox cgroup caps. |
| `SANDBOX_GPUS` | empty | `all` only if nvidia-container-toolkit is installed. |
| `TUNNEL_MODE` | `bore` | `bore` = dial out (use this). `local` = SSH on `127.0.0.1` only. |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Liveness ping. |
| `REGISTRY_URL` | hosted registry | Set only when self-hosting. Bare host gets `http://` prepended. |

Do not set bore server/secret. The registry sends them in hello ack.

Inline `FOO=bar npm run dev` overrides `.env`.

## Deploy — pick one

### A. Native (default on Mac/Windows, and required for `TUNNEL_MODE=local`)

```bash
npm install
npm run start
```

Use `npm run dev` only if you want `tsx watch` during development.

### B. Docker Compose (Linux hosts, `TUNNEL_MODE=bore`)

```bash
docker compose up --build -d
docker compose logs -f
```

The agent does **not** run Docker-in-Docker. It mounts `/var/run/docker.sock` and starts sandboxes as **sibling** containers on the host daemon.

Do **not** enable `network_mode: host` unless `TUNNEL_MODE=local`. On Docker Desktop (Mac/Windows), host networking does not share loopback — for local mode run native (A), not Compose.

Compose v1: `docker-compose` (hyphen).

### C. One-off `docker run`

```bash
docker build -t tendril-contributor .
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --env-file .env \
  --restart unless-stopped \
  tendril-contributor
```

Add `--network host` only for `TUNNEL_MODE=local` on Linux.

## Verify

1. Logs show `registered as node n_…` and an owner address.
2. No `TENDRIL_API_KEY is required` and no `registry error`.
3. Process stays up; disconnects should reconnect and hello again.
4. First rent builds `sandbox-ssh` on the host (~30s, compiles `bore` for this arch). Later rents are cached. Image tag is content-hashed from `sandbox-ssh/Dockerfile` + `entrypoint.sh`.

Failure → cheapest probe:

| Symptom | Check |
|---|---|
| Exit on start, missing key | `.env` / `Setup Prompt.md` |
| `registry error` after hello | Key revoked or wrong; `GET /keys` with session token |
| Cannot talk to Docker | `docker info`; Compose volume `docker.sock` |
| `TUNNEL_MODE=local` on Docker Desktop | Run native instead |
| Client version too old | Use this repo’s Dockerfile (static Docker CLI 27.x), not Debian `docker.io` |

## Runtime rules (do not “improve”)

- Never add host `-v` mounts for sandboxes.
- Never publish sandbox SSH on `0.0.0.0`.
- Never put a wallet mnemonic/private key in `.env`.
- `SIGINT` must destroy sandboxes. Restarts drop in-memory leases.
- This agent never moves funds. Withdraw is `POST /withdraw` with the **wallet session token** — see `Setup Prompt.md`. Wallet must be opted into USDC (testnet ASA `10458941`) at withdraw time; earnings accrue either way. Minimum withdraw 5 USDC.

## Done when

- Agent process is running (native or Compose).
- Log line: `registered as node n_… ; earnings go to <wallet>`.
- `TENDRIL_API_KEY` is not echoed in logs.

Then stop. Do not open inbound ports. Do not withdraw unless asked.
