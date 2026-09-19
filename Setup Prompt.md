# Setup Prompt — Mint a Tendril contributor API key

You are setting up credentials so a Tendril contributor worker can run. Do this **before** `AgentDeploy Prompt.md`. Do not deploy until `TENDRIL_API_KEY` is in `.env`.

## Goal

Produce a live `tnd_…` secret, write it to this repo’s `.env` as `TENDRIL_API_KEY`, and confirm the key is listed. Everything below is gated by a **session token** from the wallet that signed in — keys, earnings, and withdraw all belong to that wallet.

## Inputs you must have

| Name | What it is |
|---|---|
| `$API` | Platform API base. Default hosted registry: `https://tendrilregister.007575.xyz` |
| `$TOKEN` | Session Bearer from wallet sign-in. Not the contributor API key. Tied to the signed-in wallet. |

If `$TOKEN` is missing, stop and ask the operator to sign in with their wallet and paste the session token. Do not invent auth URLs. Do not use a contributor key (`tnd_…`) as `$TOKEN`.

## Trust model (do not skip)

- `POST /keys` returns the **secret once**. Only a sha256 is stored. Lost key → mint another, never recover.
- Put the secret in the agent `.env` as `TENDRIL_API_KEY`. Anyone holding it can **register a node as this wallet** — they cannot spend credit, withdraw earnings, or sign on-chain.
- Withdraw and key management use `$TOKEN` (wallet session), not `TENDRIL_API_KEY`.

## 1. List existing keys

```bash
curl -s "$API/keys" -H "authorization: Bearer $TOKEN" | jq
```

Expected shape:

```json
{
  "keys": [
    {
      "id": 12,
      "label": "",
      "preview": "tnd_a1b2…z9y8",
      "createdAt": 1750000000000,
      "lastUsedAt": 1750000600000
    }
  ]
}
```

Secrets are never returned here — only `preview` to tell keys apart.

- `401` / missing auth → `$TOKEN` is wrong or expired. Stop.
- Empty `keys` → mint a new one (step 2).
- Operator already has a working `tnd_…` for this machine → skip mint; go to step 3.

## 2. Mint a key

Use a label that identifies **this machine** (hostname, box name). Example: `ryzen box`.

```bash
curl -s -X POST "$API/keys" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"THIS_MACHINE_LABEL"}' | jq
```

Expected shape:

```json
{
  "key": {
    "id": 13,
    "label": "ryzen box",
    "preview": "tnd_c3d4…w7v6",
    "createdAt": 1750000000000,
    "lastUsedAt": null
  },
  "secret": "tnd_c3d4………………w7v6"
}
```

Copy `secret` immediately. It will not appear again.

## 3. Write `.env`

From this repo root:

```bash
test -f .env || cp .env.example .env
```

Set at least:

```
TENDRIL_API_KEY=<secret from POST /keys>
NODE_LABEL=<same label you minted, or a human name for the explorer>
PRICE_PER_HOUR_USD=1.0
```

Leave `REGISTRY_URL` unset unless self-hosting (agent defaults to `https://tendrilregister.007575.xyz`).

Never commit `.env`. Never print the full secret in logs, tickets, or chat after it is written.

## 4. Confirm

```bash
curl -s "$API/keys" -H "authorization: Bearer $TOKEN" | jq
```

You should see the new `id`, `label`, and matching `preview`. Then hand off to `AgentDeploy Prompt.md`.

## Optional — revoke

Revoke a key you own. Any agent still using it is rejected at its next hello.

```bash
curl -s -X DELETE "$API/keys/KEY_ID" -H "authorization: Bearer $TOKEN"
```

`{"ok":true}` on success. Revoking a key you do not own is **404, not 403** — an id guess tells you nothing.

## Optional — withdraw earnings

Cash the **whole** earnings balance to the signed-in wallet, on-chain, one transfer. Uses `$TOKEN`, not `TENDRIL_API_KEY`.

```bash
curl -s -X POST "$API/withdraw" -H "authorization: Bearer $TOKEN" | jq
```

Expected shape:

```json
{
  "amountAtomic": 5500000,
  "txid": "ABCD…",
  "earningsAtomic": 0
}
```

Rules:

- All-or-nothing. Floor is `minWithdrawAtomic` (5 USDC by default; see `GET /platform`).
- Leases credit a balance; they do not pay out per session.
- Wallet **must be opted into the payment asset** first. That is checked before debit. Send-fail after debit → balance refunded, attempt recorded as failed.
- Do not withdraw as part of a first-time agent setup unless the operator asked.

## Done when

- `.env` exists with a non-empty `TENDRIL_API_KEY` starting with `tnd_`
- `GET /keys` shows that key’s preview
- You have **not** stored `$TOKEN` in the agent `.env` (session token is not an agent credential)
