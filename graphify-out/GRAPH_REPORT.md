# Graph Report - .  (2026-09-24)

## Corpus Check
- Corpus is ~5,967 words - fits in a single context window. You may not need a graph.

## Summary
- 161 nodes · 229 edges · 11 communities (8 shown, 3 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Sandbox Trust Model|Sandbox Trust Model]]
- [[_COMMUNITY_Earnings And Withdrawal|Earnings And Withdrawal]]
- [[_COMMUNITY_Agent Protocol Types|Agent Protocol Types]]
- [[_COMMUNITY_Docker Sandbox Lifecycle|Docker Sandbox Lifecycle]]
- [[_COMMUNITY_Node Package Manifest|Node Package Manifest]]
- [[_COMMUNITY_Deploy And Compose|Deploy And Compose]]
- [[_COMMUNITY_TypeScript Compiler Config|TypeScript Compiler Config]]
- [[_COMMUNITY_API Key Setup|API Key Setup]]
- [[_COMMUNITY_Sandbox Entrypoint|Sandbox Entrypoint]]
- [[_COMMUNITY_Container Ready Event|Container Ready Event]]
- [[_COMMUNITY_Heartbeat Liveness|Heartbeat Liveness]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 15 edges
2. `Tendril Contributor Agent` - 11 edges
3. `startSandbox()` - 10 edges
4. `Hardened Ephemeral Docker SSH Sandbox` - 10 edges
5. `Contributor Worker Daemon` - 8 edges
6. `Registry-Agent WebSocket Protocol` - 7 edges
7. `Bore Tunnel` - 7 edges
8. `Hardened Ephemeral Docker SSH Sandbox` - 7 edges
9. `Wallet Session Token` - 7 edges
10. `Container Trust Model` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Tendril Contributor Agent` --semantically_similar_to--> `Contributor Worker Daemon`  [INFERRED] [semantically similar]
  README.md → AgentDeploy Prompt.md
- `Container Trust Model` --semantically_similar_to--> `API Key vs Session Token Trust Model`  [INFERRED] [semantically similar]
  README.md → Setup Prompt.md
- `TENDRIL_API_KEY` --semantically_similar_to--> `TENDRIL_API_KEY`  [INFERRED] [semantically similar]
  README.md → AgentDeploy Prompt.md
- `TENDRIL_API_KEY` --semantically_similar_to--> `TENDRIL_API_KEY`  [INFERRED] [semantically similar]
  README.md → Setup Prompt.md
- `Sibling Containers via Docker Socket` --semantically_similar_to--> `Sibling Containers via Docker Socket`  [INFERRED] [semantically similar]
  README.md → AgentDeploy Prompt.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Paid lease lifecycle over WebSocket** — readme_hello, readme_heartbeat, readme_start_container, readme_container_ready, readme_destroy_container, readme_bore_tunnel [EXTRACTED 1.00]
- **Container-as-boundary sandbox hardening** — readme_trust_model, readme_ssh_sandbox, readme_cap_drop_all, readme_cgroup_caps, readme_bore_tunnel, readme_sibling_containers [EXTRACTED 1.00]
- **Split credentials: session token, API key, no host wallet** — setup_prompt_session_token, setup_prompt_tendril_api_key, setup_prompt_trust_model, readme_no_wallet_key, setup_prompt_post_withdraw [EXTRACTED 1.00]

## Communities (11 total, 3 thin omitted)

### Community 0 - "Sandbox Trust Model"
Cohesion: 0.09
Nodes (27): Bore Config via Hello Ack, Bore Tunnel, Content-Hashed Sandbox Image Tag, Hardened Ephemeral Docker SSH Sandbox, start-container, Bore Config via Hello Ack, bore (ekzhang), Bore Tunnel (+19 more)

### Community 1 - "Earnings And Withdrawal"
Cohesion: 0.11
Nodes (23): destroy-container, No Wallet Key on Agent Host, POST /withdraw, Runtime Hardening Rules, SIGINT Sandbox Destroy, Backend Money Handling, destroy-container, Earnings Balance (+15 more)

### Community 2 - "Agent Protocol Types"
Cohesion: 0.16
Nodes (17): activeLeases, handleRun(), main(), AgentHelloMsg, ContainerFailedMsg, ContainerReadyMsg, DestroyContainerMsg, HeartbeatMsg (+9 more)

### Community 3 - "Docker Sandbox Lifecycle"
Cohesion: 0.18
Nodes (17): config, containerName(), dockerNcpu(), ensureImage(), execFileP, getFreePort(), runInSandbox(), SANDBOX_CTX (+9 more)

### Community 4 - "Node Package Manifest"
Cohesion: 0.11
Nodes (18): dependencies, dotenv, socket.io-client, tsx, description, devDependencies, @types/node, typescript (+10 more)

### Community 5 - "Deploy And Compose"
Cohesion: 0.13
Nodes (18): Docker Compose Deploy, Contributor Worker Daemon, AgentDeploy Prompt, One-off docker run Deploy, Hello Handshake, Hosted Registry tendrilregister.007575.xyz, Native Deploy (npm), Sibling Containers via Docker Socket (+10 more)

### Community 6 - "TypeScript Compiler Config"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 7 - "API Key Setup"
Cohesion: 0.20
Nodes (12): Hosted Registry tendrilregister.007575.xyz, Tendril Registry, DELETE /keys, .env Credential File, GET /keys, Hosted Registry tendrilregister.007575.xyz, POST /keys, Revoke Returns 404 not 403 (+4 more)

## Knowledge Gaps
- **53 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+48 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Tendril Contributor Agent` connect `Earnings And Withdrawal` to `Sandbox Trust Model`, `Deploy And Compose`, `API Key Setup`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Why does `Contributor Worker Daemon` connect `Deploy And Compose` to `Earnings And Withdrawal`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `Hardened Ephemeral Docker SSH Sandbox` connect `Sandbox Trust Model` to `Earnings And Withdrawal`, `Deploy And Compose`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _56 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Sandbox Trust Model` be split into smaller, more focused modules?**
  _Cohesion score 0.09401709401709402 - nodes in this community are weakly interconnected._
- **Should `Earnings And Withdrawal` be split into smaller, more focused modules?**
  _Cohesion score 0.11067193675889328 - nodes in this community are weakly interconnected._
- **Should `Node Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._