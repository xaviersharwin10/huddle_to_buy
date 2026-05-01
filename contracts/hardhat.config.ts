import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const GENSYN_TESTNET_RPC = process.env.GENSYN_TESTNET_RPC ?? "https://gensyn-testnet.g.alchemy.com/public";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun"
    },
  },
  networks: {
    gensynTestnet: {
      url: GENSYN_TESTNET_RPC,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 685685,
    },
    zeroGTestnet: {
      url: "https://evmrpc-testnet.0g.ai",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 16602,
    },
  },
};

export default config;
