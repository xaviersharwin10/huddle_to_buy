# Huddle

> **Huddle** is a fully autonomous coalition-buying protocol. It enables independent AI agents to dynamically discover each other via a P2P mesh network, pool their capital into ephemeral smart contracts, and execute trustless, atomic purchases on the Gensyn EVM Testnet.

---

## 💡 Value Proposition

### The Problem
Digital subscriptions and compute resources are priced for enterprises, not individuals. A single buyer pays full retail. Three buyers could unlock a 15–25% bulk tier — but only if they can trust each other, coordinate instantly, and settle atomically. Today, that coordination requires a broker, a platform, or a human in the loop. All of these add friction, fees, and a single point of failure.

For AI agents operating in the machine-to-machine economy, the problem is worse: an agent trying to procure H100 GPU hours or a premium API subscription may simply not have enough capital on its own — and there is no infrastructure for agents to form buying groups autonomously.

### The Solution
Huddle removes the middleman entirely. When you (or your AI agent) submit a purchase intent, Huddle:

1. **Broadcasts** your intent as a privacy-preserving commitment hash across a decentralized P2P mesh — no central server ever sees your price or identity.
2. **Discovers** other buyers with identical intent in real time using GossipSub on the Gensyn AXL network.
3. **Negotiates** the bulk tier price autonomously via an X402 micropayment to the seller — machine-to-machine, on-chain.
4. **Deploys** an ephemeral Coalition Smart Contract on the Gensyn Testnet in seconds, with each buyer funding their share independently.
5. **Settles** atomically: KeeperHub triggers `commit()` when all funds are in, transferring payment to the seller. If anyone drops out, `refundAll()` returns every token — no trust required.

### Why It Matters

| Without Huddle | With Huddle |
|---|---|
| Pay full retail price | Unlock bulk tier (15–25% savings) |
| Manual group coordination | Fully autonomous — zero human steps |
| Custodial broker holds funds | Ephemeral smart contract — non-custodial |
| Agents priced out of premium compute | Any agent can join a coalition |
| Opaque bulk deals | Every step is on-chain and verifiable |

Huddle is a foundational primitive for the **Agent Economy** — the infrastructure layer that lets AI agents pool resources, negotiate as a collective, and settle trustlessly, just like humans do with group buys, but at machine speed and with cryptographic guarantees.

---

## 📖 The Vision

In the emerging machine-to-machine (M2M) economy, AI agents frequently need to procure expensive digital assets—such as high-end GPU compute clusters (via Gensyn) or valuable iNFTs. However, individual agents often lack the standalone capital to make these purchases.

**Huddle** solves this by introducing decentralized **Coalition Buying**. Instead of failing a task due to insufficient funds, an agent broadcasts a "purchase intent" across a privacy-preserving P2P mesh network. Other agents with similar intents discover each other, negotiate terms, pool their resources on-chain, and execute the purchase as a unified entity. 

If anyone flakes, the transaction atomically reverts and all funds are refunded.

## 🏗 Architecture & Tech Stack

Huddle is built on a cutting-edge stack designed for autonomous agent coordination and low-latency settlement.

### 1. P2P Discovery Layer (Gensyn AXL)
Instead of relying on centralized matchmaking servers, Huddle agents communicate via **AXL**, a robust gossip protocol mesh network. Agents broadcast their encrypted intents (e.g., "I need 20 hours of H100 compute and can contribute 500 USDC").

### 2. Autonomous Agent Daemons (TypeScript)
Each buyer runs an independent TypeScript daemon. 
- The agents listen to the mesh network.
- Upon discovering a matching intent, they autonomously elect a "Coordinator" using a K-Anonymity matching algorithm.
- The coordinator negotiates with the Seller Agent and finalizes the terms.

### 3. X402 Price Negotiation
Before deploying any contract, the coordinator agent pays 0.01 MockUSDC to the seller's **X402** HTTP endpoint to unlock the bulk tier price. The seller verifies the on-chain Transfer event before responding — a real machine-to-machine micropayment, not a simulated one.

### 4. Trustless Settlement Layer (Gensyn EVM Testnet)
Once terms are agreed upon, the coordinator deploys an ephemeral **Coalition Smart Contract** to the **Gensyn Testnet** (Chain ID: 685685).
- Each buyer agent autonomously approves and calls `fund()` using **Viem** and `MockUSDC`.
- When the funding threshold is met, **KeeperHub** autonomously triggers the final `commit()`, atomically transferring funds to the seller.
- If the threshold is not met by the deadline, `refundAll()` trustlessly returns all USDC.

### 5. 0G Network Integration
Every buyer agent is wired into three 0G primitives:
- **0G Storage** — agent preference profiles are uploaded as Merkle-DAG blobs at startup.
- **0G Compute** — the accept/reject decision for the seller's bulk offer is delegated to `qwen/qwen-2.5-7b-instruct` running on the 0G Compute Marketplace.
- **0G iNFT** — each agent holds an ERC-7857 `BuyerProfile` NFT. After every successful coalition, it seals the deal fingerprint on-chain via `sealInference()`.

### 6. Telegram Bot Interface
Users interact with Huddle through a Telegram bot powered by Gemini NLU. Send a natural-language purchase intent, receive real-time status updates as the coalition forms, and get a full settlement receipt — including clickable X402 and 0G transaction links — all without leaving the chat.

---

## 🚀 Quick Start Guide

### Prerequisites
- Node.js (v18+)
- `pnpm`
- A MetaMask wallet funded with Gensyn Testnet ETH.

### 1. Clone & Install
```bash
git clone https://github.com/xaviersharwin10/huddle_to_buy.git
cd huddle_to_buy
pnpm install
```

### 2. Configure Environment
Huddle requires 4 separate wallets (1 Deployer/Keeper + 3 Buyers). Copy the environment templates and insert your private keys.
```bash
cp contracts/.env.gensyn-testnet.example contracts/.env
cp agent/.env.buyer1.example agent/.env.buyer1
cp agent/.env.buyer2.example agent/.env.buyer2
cp agent/.env.buyer3.example agent/.env.buyer3
```

### 3. Deploy Smart Contracts
Deploy the `CoalitionFactory` and `MockUSDC` token to the Gensyn Testnet, then mint USDC to your buyer wallets.
```bash
cd contracts
pnpm exec hardhat run scripts/deploy.ts --network gensynTestnet
# Mint USDC
PAY_TOKEN_ADDRESS=<mock-usdc> pnpm exec hardhat run scripts/mint-mock-usdc.ts --network gensynTestnet
```
*Make sure to update your `agent/.env.*` files with the deployed Factory and Token addresses!*

### 4. Run the E2E Demo
We provide a fully automated script that spins up the P2P mesh network, starts the agents, deploys the coalition, funds it, and executes the final keeper transaction.

```bash
bash scripts/happy-path.sh
```

---

## 🛠 Hackathon Tracks & Bounties

Huddle was specifically engineered to showcase the power of the **Gensyn** ecosystem and its partner integrations:

- **Gensyn L2 Usage:** 100% of the on-chain settlement, contract logic, and token transfers execute on the Gensyn EVM Testnet (Chain ID 685685). The Coalition smart contract, MockUSDC approvals, fund(), and commit() transactions are all native Gensyn Testnet activity.

- **AXL Integration:** We replaced centralized backends with Gensyn's AXL P2P mesh network. Agents broadcast encrypted purchase intents via GossipSub, discover coalition partners, and coordinate the entire negotiation flow without any central server.

- **0G Network — Storage, Compute & iNFT:** Huddle uses three distinct 0G primitives:
  - **0G Storage:** On agent startup, each buyer's preference profile is uploaded as a Merkle-DAG blob to 0G Storage and content-addressed via `0g://` URI.
  - **0G Compute:** When the seller returns a bulk price quote, the coordinator delegates the accept/reject decision to `qwen/qwen-2.5-7b-instruct` running on the 0G Compute Marketplace — an autonomous AI-to-AI negotiation.
  - **0G iNFT (ERC-7857):** Each buyer agent mints a `BuyerProfile` iNFT on 0G Testnet at init time. After successfully funding a coalition, the agent seals the outcome into the iNFT via `sealInference()`, creating a verifiable, on-chain record of every deal the agent has ever participated in. The iNFT address is `0x53764E22f4976D5cC824FaE00BADB792D942EE71` on 0G Testnet.

- **KeeperHub Automation:** Rather than requiring a human to trigger the final `commit()`, Huddle registers a KeeperHub workflow that monitors each Coalition contract. When the funding threshold is met, KeeperHub's cloud infrastructure autonomously calls `commit()`, atomically transferring MockUSDC to the seller — zero human intervention from intent to settlement.

- **X402 Micropayments:** Price discovery between the coordinator agent and the seller agent is gated by an X402 payment flow. Before receiving the bulk tier price, the coordinator autonomously sends a 0.01 MockUSDC on-chain payment to the seller's treasury. The seller verifies the Transfer event on-chain before returning the quote — a real machine-to-machine micropayment protocol.

- **AI x Crypto:** Huddle is a foundational primitive for the Agent Economy, proving that AI agents can collaboratively discover peers, negotiate prices via micropayments, pool capital into trustless escrow, and settle autonomously — without any human intervention at any step.

---
