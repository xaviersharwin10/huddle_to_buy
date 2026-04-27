import type { Intent } from "./intent.js";

export type CommitEnv = {
  v: 1;
  kind: "commit";
  from: string;
  commitment: string;
};

export type RevealReqEnv = {
  v: 1;
  kind: "reveal_request";
  from: string;
  commitment: string;
  intent: Intent;
  nonce: string;
};

export type RevealRespEnv = {
  v: 1;
  kind: "reveal_response";
  from: string;
  commitment: string;
  intent: Intent;
  nonce: string;
};

export type NegotiateReqEnv = {
  v: 1;
  kind: "negotiate_request";
  from: string;
  commitment: string;
  sku: string;
  n_buyers: number;
  unit_qty: number;
  max_unit_price: number;
};

export type NegotiateRespEnv = {
  v: 1;
  kind: "negotiate_response";
  from: string;
  commitment: string;
  sku: string;
  n_buyers: number;
  unit_qty: number;
  tier_unit_price?: number;
  valid_until_ms?: number;
  decline_reason?: string;
};

export type CoalitionReadyEnv = {
  v: 1;
  kind: "coalition_ready";
  from: string;
  commitment: string;
  coalition_address: `0x${string}`;
  chain_id: number;
};

export type Envelope =
  | CommitEnv
  | RevealReqEnv
  | RevealRespEnv
  | NegotiateReqEnv
  | NegotiateRespEnv
  | CoalitionReadyEnv;
