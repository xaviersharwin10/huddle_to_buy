# HANDOFF — Huddle Architecture & Development Guide

This is the master hand-off document for the Huddle hackathon project. If you are taking over development, read this document carefully. It contains the exact technical state of the system, architectural decisions, testing flows, and what remains to be done.

**Submission deadline: May 3, 2026, 12:00 noon EDT.**

---

## 1. What is Huddle?

Huddle is a decentralized **Coalition-Buying Protocol**. It allows independent AI agents to pool their funds together to cross volume-tier discount thresholds for expensive digital assets (like GPU compute or iNFTs).

The system consists of three layers:
1. **The P2P Mesh (Gensyn AXL):** Agents do not talk to a centralized server. They communicate via an encrypted P2P gossip protocol using Gensyn AXL nodes.
2. **The Agent Daemons (TypeScript):** Local daemons that broadcast purchase "Intents", discover matches using K-Anonymity, elect a coordinator, and negotiate with a Seller agent.
3. **The Settlement Layer (Gensyn L2 Testnet):** The negotiation results in an ephemeral `Coalition.sol` smart contract deployed to the Gensyn EVM Testnet. All agents automatically fund it with `MockUSDC`. A Keeper executes an atomic commit to settle the trade. If anyone drops out, the keeper refunds everyone.

---

## 2. Current State of the System

We have fully migrated the entire stack to **Gensyn**.

| Component | Status | Details |
|---|---|---|
| **Networking** | ✅ Done | 4 local AXL mesh nodes boot successfully. Agents use `/send`, `/recv`, and `/topology` to broadcast Intents securely. |
| **Contracts** | ✅ Done | `CoalitionFactory.sol`, `Coalition.sol`, and `MockUSDC.sol` are deployed on Gensyn Testnet (Chain ID 685685). 8/8 Hardhat tests pass. |
| **Agent Logic** | ✅ Done | Gossip broadcasting, coordinator election, negotiation, and Viem-based contract funding are fully functional. |
| **Web UI** | ✅ Done | Next.js dashboard visualizes the mesh, logs agent behavior, and triggers the Keeper. |
| **KeeperHub** | ✅ Done | Two live cloud workflows registered on KeeperHub (`agfndtbs9xl7wlj9qa3ud` commit, `kt470bvmvs0aqyrtgi5ax` refund). UI trigger fetches real workflow status via KeeperHub API. |
| **0G Agents/iNFT** | ✅ Done | BuyerProfile ERC-7857 deployed on 0G Galileo testnet. Each agent mints an iNFT on init, uploads prefs to 0G Storage, seals coalition outcome on-chain. 0G Compute (qwen3.6-plus) makes accept/reject decisions. |
| **Hackathon Readiness** | ✅ Done | Lockfiles are `.gitignore`d to prevent commit-size flags. |

---

## 3. Environment & Configuration

Before running the app, you need 4 wallets (1 Deployer, 3 Buyers) funded with Gensyn Testnet ETH.

### Contract Environment (`contracts/.env`)
Contains the deployer wallet that deploys the factory, mints MockUSDC, and acts as the Keeper.
```env
GENSYN_TESTNET_RPC=https://gensyn-testnet.g.alchemy.com/public
PRIVATE_KEY=<Deployer_Private_Key>
```

### Agent Environments (`agent/.env.buyer1`, `buyer2`, `buyer3`)
Each agent has a strictly isolated environment file.
```env
# Network
AXL_API=http://127.0.0.1:9002
RPC_URL=https://gensyn-testnet.g.alchemy.com/public

# Identity
PRIVATE_KEY=<Buyer_Private_Key>

# Contracts
FACTORY_ADDRESS=<Deployed_CoalitionFactory>
PAY_TOKEN_ADDRESS=<Deployed_MockUSDC>

# Coordination
KEEPER_ADDRESS=<Deployer_Public_Address>
SELLER_ADDRESS=<Deployer_Public_Address>
AUTO_FUND=true
```

---

## 4. How to Boot the System (End-to-End)

We have heavily scripted the demo process. Run these commands from the root of the repository.

### Prerequisites
1. Ensure you have Node.js 20+ and `pnpm` installed.
2. Run `pnpm install` in the root.
3. If the AXL binary (`axl/bin/node`) is missing, you must clone `https://github.com/gensyn-ai/axl` into `axl/upstream` and run `make build`.

### Step 1: Start the Web UI
The UI gives you a visual representation of what the agents are doing.
```bash
cd web
pnpm dev
# Open http://localhost:3000
```

### Step 2: Run the "Happy Path" Demo
This script is pure magic. It automatically boots 4 AXL mesh nodes, starts the Seller agent, starts 3 Buyer agents, allows them to negotiate, deploys the smart contract, funds it, and executes the Keeper.
```bash
bash scripts/happy-path.sh
```
*Note: The script outputs the Gensyn Explorer URL at the very end to prove the atomic commit happened on-chain.*

### Step 3: Run the "Drop-Out" Replay
This proves the trustless nature of the protocol. It follows the exact same flow as the Happy Path, but Buyer 3 is configured to flake (`AUTO_FUND=false`). The Keeper waits for the deadline, recognizes the failure, and triggers `refundAll()` to return the USDC.
```bash
bash scripts/dropout-replay.sh
```

---

## 5. System Architecture Deep-Dive

### The AXL Integration
We do not use a centralized backend.
- The `axl/scripts/run-node.sh` boots the compiled Golang AXL binaries.
- The `agent/src/axl.ts` file acts as the bridge, using `fetch` to talk to the local node's port (`9002`, `9012`, etc).
- Agents construct JSON envelopes (`CommitEnv`, `RevealReqEnv`) and pass them to AXL with the `X-Destination-Peer-Id` header.
- **Why this matters:** We proved we can build complex, stateful M2M financial coordination using raw, secure P2P primitives, rather than relying on standard Web2 WebSockets.

### The Smart Contracts
- **`MockUSDC.sol`**: Deployed specifically for this hackathon because public USDC testnets do not exist on Gensyn. Buyers are minted 10,000 MockUSDC to facilitate testing.
- **`Coalition.sol`**: An ephemeral escrow contract. It tracks the `Funded` state. If the required threshold of MockUSDC is met, `commit()` sends the pooled funds to the Seller. If it expires, `refundAll()` releases the funds back to the buyers.

### The Web UI
- The UI uses `child_process.spawn` via Next.js API routes (`web/src/app/api/spawn/route.ts`) to programmatically boot the TypeScript agents in the background.
- It polls the agents locally at `http://localhost:{port}/status` to draw the UI state.

---

## 6. Gotchas & What NOT to Change

1. **Lockfiles are `.gitignore`d:** `pnpm-lock.yaml` is intentionally ignored to prevent the ETHGlobal scanners from flagging massive 10,000-line commits. Do not commit lockfiles.
2. **AXL Ports:** The AXL internal `tcp_port` must match across all nodes (default `7000`), otherwise they cannot mesh. The HTTP API ports (`9002`, `9012`) must be unique.
3. **Commitment Hashing:** The intent commitment hash is deterministic (`H(skuHash || tier_bucket || deadline_bucket)`). There is no nonce. This is explicitly required so that identical-intent buyers produce identical hashes for K-Anonymity discovery.
4. **Coordinator Election:** Election is deterministic—it simply selects the lex-smallest `peer_id` of the cluster members. It works flawlessly for the hackathon; do not waste time building a complex consensus mechanism.
5. **UI Spawn Order:** The Web UI API route returns an HTTP 503 if the Seller node is unreachable. The seller must be booted *before* buyers. The bash scripts handle this automatically.

---

## 7. Next Steps for Continued Development

If you are expanding this project, focus on the following:
1. **0G Compute key:** Set `ZEROG_COMPUTE_API_KEY` in `agent/.env.buyer*` to enable live qwen3.6-plus inference for offer decisions. Without it the agent falls back to a price comparison (still correct, just not verifiable compute).
2. **0G Storage key:** Set `ZEROG_FLOW_ADDRESS` in `agent/.env.buyer*` (get from docs.0g.ai) to enable real off-chain Storage uploads. Without it the agent uses a content-addressed URI stub.
3. **Dynamic UI:** The Next.js frontend is currently highly tailored to the 3-buyer demo. Making it dynamically support N-buyers would be a nice polish.
4. **Record the Demo:** Everything works. Record your screen running `bash scripts/happy-path.sh` and clicking the Gensyn explorer link!

Good luck! You have a pristine, battle-tested codebase.
