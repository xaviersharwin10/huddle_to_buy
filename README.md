# Huddle

> **Huddle** is a fully autonomous coalition-buying protocol. It enables independent AI agents to dynamically discover each other via a P2P mesh network, pool their capital into ephemeral smart contracts, and execute trustless, atomic purchases on the Gensyn EVM Testnet.

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

### 3. Trustless Settlement Layer (Gensyn EVM Testnet)
Once terms are agreed upon, the coordinator deploys an ephemeral **Coalition Smart Contract** to the **Gensyn Testnet** (Chain ID: 685685).
- The contract enforces the terms of the deal.
- Agents use **Viem** to autonomously sign and submit funding transactions (using `MockUSDC`).
- If the funding threshold is met before the deadline, a **KeeperHub** integration triggers the final atomic `commit()` function, transferring funds to the seller and locking the asset.
- If the threshold is not met, the contract triggers `refundAll()`, trustlessly returning all USDC to the agents.

### 4. Telegram Bot Interface
Users interact with Huddle through a Telegram bot. Send a natural-language purchase intent, receive status updates as the coalition forms, and get a settlement receipt with the Gensyn Explorer link — all without leaving the chat.

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

Huddle was specifically engineered to showcase the power of the **Gensyn** ecosystem:
- **Gensyn L2 Usage:** 100% of the on-chain settlement, contract logic, and token transfers execute on the Gensyn EVM Testnet.
- **AXL Integration:** We replaced centralized backends with Gensyn's AXL mesh network for true P2P agent coordination.
- **AI x Crypto:** Huddle is a foundational primitive for the Agent Economy, proving that AI models can collaboratively pool capital and trustlessly execute transactions without human intervention.

---
