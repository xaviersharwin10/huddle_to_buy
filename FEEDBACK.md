# KeeperHub Integration Feedback

Project: **Huddle-to-Buy** — a multi-agent coalition-buying protocol for AI agents on Gensyn Testnet.
Integrator: Sharwin (sharwinrmsa@gmail.com)
Build period: 8 days, OpenAgents / KeeperHub hackathon track.

---

## What worked well

**The separation of concerns is correct.** Having a keeper EOA that is authorized to call `commit()` / `refundAll()` but holds no funds is exactly the right trust model for multi-party escrow. We adopted this pattern (a single `KEEPER_ADDRESS` stored in Coalition.sol at deploy time) and it integrated cleanly with how KeeperHub jobs are described.

**The mapping JSON concept is powerful.** Declarative trigger descriptions that map events + conditions to function calls are the right abstraction. Once we understood the schema it was straightforward to express our two business rules: commit on threshold, refund on expiry.

---

## Friction points encountered

### 1. `DRY_RUN=true` silently skips — no validation of the payload

**What happened:** We set `DRY_RUN=true` during development (the default), which correctly skips the API call. But the payload is never validated against KeeperHub's schema. We had a typo in `actions[].when` for several hours and had no indication anything was wrong until we tried a live registration.

**Request:** A `--validate-only` or `--dry-run-schema-check` flag that POSTs to a KeeperHub validation endpoint (no job created, no billing) and returns field-level errors. Even a JSON Schema published for the mapping format would let us catch errors locally.

---

### 2. The `when` condition DSL is completely undocumented

**What happened:** The `when` field in `actions[]` is a condition expression, but there is no documentation for:
- What **variable names** are in scope (`funded_count`? `buyerCount`? `fundedCount`?). We guessed `funded_count` based on the event field name.
- What **state enum values** are valid literals (`Funded`, `"Funded"`, `1`?). We wrote `state == Funded` and don't know if that resolves correctly.
- Whether **compound conditions** (`&&`, `||`) are supported or if you must split them into separate actions.
- Whether `now` is seconds or milliseconds (we assumed seconds since `validUntil` is a Unix timestamp).

**Request:** A one-page DSL reference listing the built-in variables, operators, and how contract state/enum values are referenced. A working example with a real threshold trigger would unblock most integrators immediately.

---

### 3. No multi-party / threshold trigger examples in the docs

**What happened:** Our use case is N-of-N: commit when `buyerCount == requiredBuyers`. This is the canonical KeeperHub use case (threshold-triggered keeper action) but there are no examples of it in the docs. We reverse-engineered the condition syntax from the event field names.

**Request:** A "threshold trigger" example alongside the standard time-based trigger. Something like:

```json
{
  "name": "commit-on-threshold",
  "when": "state == Funded && funded_count == requiredBuyers && now <= validUntil",
  "call": "commit()"
}
```

With a note confirming whether `funded_count` reads from event data, contract storage, or both.

---

### 4. No sandbox environment for testing live registration

**What happened:** To test the actual registration API call (not dry-run), you need `KEEPERHUB_API_URL` and `KEEPERHUB_API_KEY`. There is no documented sandbox or staging endpoint. We didn't want to create a real production job during development, so we only ran the dry-run path and printed the payload.

**Request:** A sandbox API endpoint (e.g. `https://sandbox.keeperhub.dev/v1/jobs`) that validates and records the registration without actually scheduling keeper execution. Hackathon integrators need this to verify their payload is accepted before demo day.

---

### 5. Unclear whether KeeperHub polls or uses event-driven triggers

**What happened:** It was not clear whether KeeperHub continuously polls contract state (like our local `keeper.ts` script does) or subscribes to on-chain events and evaluates `when` conditions only when those events fire.

This matters for gas estimation: if KeeperHub polls every block, the keeper overhead is very different from event-driven. It also affects how we write the `when` condition — if conditions are only evaluated after `BuyerFunded` fires, we don't need to re-check `state`.

**Request:** One sentence in the docs: "KeeperHub evaluates `when` conditions [after each matching event / on every new block / on a fixed polling interval of N seconds]."

---

## Summary table

| # | Issue | Severity | Suggested fix |
|---|-------|----------|---------------|
| 1 | DRY_RUN gives no schema feedback | Medium | Schema validation endpoint or published JSON Schema |
| 2 | `when` DSL is undocumented | High | DSL reference page with variable names + operators |
| 3 | No threshold trigger example | High | Add canonical N-of-N example to docs |
| 4 | No sandbox environment | Medium | `sandbox.keeperhub.dev` endpoint |
| 5 | Poll vs event-driven unclear | Low | One sentence clarification in docs |

---

## Our integration artifacts

- **Coalition.sol** — the escrow contract with `commit()` and `refundAll()` guarded by `onlyKeeper`
- **keeperhub/coalition-day5-mapping.json** — the declarative job mapping
- **contracts/scripts/keeperhub-register.ts** — the registration script (set `DRY_RUN=false` + `KEEPERHUB_API_KEY` to run live)
- **contracts/scripts/keeper.ts** — local fallback keeper that polls and calls commit/refund directly

The Gensyn Testnet chain ID is `685685`. The network name we used in the mapping is `gensynTestnet`.
