# AI Steering & Candidate Intervention Audit (STEERING_AUDIT.md)

**Project:** Easy Rent Bali – Reliability Toolkit  
**Assessment Track:** Track Option C: Infrastructure, Concurrency & Fleet Reliability  
**Agent Harness:** Google Antigravity (Gemini 3.8 Flash)  
**Session ID:** `1c992486-bba3-44b4-af00-e080c18ea28f`  
**Host Environment:** Windows 11 Enterprise (PowerShell 5.1 / Node.js v22.20.0)  
**Compliance Standard:** Mandatory AI-First Audit Policy (Track C Page 3)  

---

## 1. Executive Summary

This document records authentic instances during development where AI-generated output exhibited technical flaws, syntactical incompatibilities, or architectural ambiguity, alongside the precise steering interventions applied and verified by automated tests.

Per assessment requirements, at least two concrete instances are required. Four verified cases are documented below.

---

## 2. Documented Steering Instances

### Case 1: Windows PowerShell Chained Execution Incompatibility (`&&` Operator)

- **Context:** Automated Git commit and terminal scaffolding.
- **Original AI Action / Decision:**  
  The AI attempted to execute chained bash-style compound commands in the Windows terminal:
  ```powershell
  git add . && git commit -m "chore: initialize Easy Rent Bali reliability toolkit workspace"
  ```
- **Error Encountered:**  
  The command immediately failed with a fatal PowerShell parser error:
  ```text
  At line:1 char:310
  + ... git add . && git commit ...
  +               ~~
  The token '&&' is not a valid statement separator in this version.
      + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException
      + FullyQualifiedErrorId : InvalidEndOfLine
  ```
- **Why It Was Incorrect:**  
  The host environment is Windows 11 running Windows PowerShell 5.1 (`powershell.exe`). In PowerShell 5.1, `&&` is not a valid pipeline or statement delimiter (it was only introduced in PowerShell 7+ Core). Bash/POSIX idioms fail without explicit adaptation.
- **Corrective Candidate Steering / Intervention:**  
  Enforced strict Windows PowerShell compatibility: replace `&&` with explicit semicolons (`;`) or execute commands as discrete, single-purpose subprocesses.
- **Final Implementation:**
  ```powershell
  git add .; git commit -m "chore: initialize Easy Rent Bali reliability toolkit workspace"
  ```
- **Verification Evidence:**  
  Subsequent commit succeeded cleanly, creating commit `0418ad8` with 9 tracked files.

---

### Case 2: Missing Node.js Ambient Types Under TypeScript `NodeNext`

- **Context:** Implementing `mock_repository.ts` and `checkout_handler.ts`.
- **Original AI Action / Decision:**  
  The AI authored TypeScript code utilizing Node.js runtime globals (`setTimeout`, `clearTimeout`, `NodeJS.Timeout`) and standard modules (`node:crypto`) while having a `tsconfig.json` that specified `"lib": ["ES2022"]` but omitted `"types": ["node"]`.
- **Error Encountered:**  
  Running `npm run typecheck` produced six compile-time diagnostic errors:
  ```text
  src/patch/checkout_handler.ts(64,38): error TS2304: Cannot find name 'setTimeout'.
  src/patch/idempotency.ts(6,28): error TS2591: Cannot find name 'node:crypto'.
  src/patch/mock_repository.ts(71,16): error TS2503: Cannot find namespace 'NodeJS'.
  src/patch/mock_repository.ts(74,15): error TS2552: Cannot find name 'setTimeout'. Did you mean 'timedOut'?
  src/patch/mock_repository.ts(82,7): error TS2304: Cannot find name 'clearTimeout'.
  ```
- **Why It Was Incorrect:**  
  Under modern TypeScript `NodeNext` module resolution with strict typechecking, Node ambient globals are not automatically inherited without explicit configuration in `compilerOptions.types`.
- **Corrective Candidate Steering / Intervention:**  
  Updated [tsconfig.json](file:///e:/DEVELOPMENT/easyrent-test/tsconfig.json) to explicitly inject `"types": ["node"]` into `compilerOptions`.
- **Final Implementation:**
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ES2022"],
      "types": ["node"],
      "outDir": "./dist"
    }
  }
  ```
- **Verification Evidence:**  
  Executed `npm run typecheck`. TypeScript exited with code 0 with zero errors across all source and test files.

---

### Case 3: Bandwidth Shaping Policy Ambiguity (VLAN 50 Guest Wi-Fi)

- **Context:** Drafting Part 1 Network Architecture QoS policies.
- **Original AI Action / Decision:**  
  Initial draft mixed up the normal QoS rate-limit with the emergency failover limit, proposing to throttle individual guest clients to $128\text{ kbps}$ on WAN2 while keeping the queue aggregate open.
- **Why It Was Incorrect:**  
  Allowing 50 guest clients to each consume $128\text{ kbps}$ would result in $50 \times 128\text{ kbps} = 6.4\text{ Mbps}$ aggregate bandwidth consumption. On a constrained cellular uplink of $5-10\text{ Mbps}$, this would still saturate the cellular channel and starve POS, Kiosk, and IoT telemetry streams.
- **Corrective Candidate Steering / Intervention:**  
  Mandated strict policy decoupling in [docs/NETWORK_ARCHITECTURE.md](file:///e:/DEVELOPMENT/easyrent-test/docs/NETWORK_ARCHITECTURE.md):
  - **Normal Operation (WAN1 Fiber):** Per-client rate limit of **$2\text{ Mbps}$ per guest**.
  - **Emergency Operation (WAN2 Cellular):** An **aggregate queue limit of $< 128\text{ kbps}$ across the entire VLAN 50 subnet** (or total traffic drop), reserving $100\%$ of remaining bandwidth for POS and IoT.
- **Verification Evidence:**  
  Validated in Section 6.1 and 6.2 of `docs/NETWORK_ARCHITECTURE.md` and demonstrated in the RouterOS Netwatch failover queue script.

---

### Case 4: Process-Local Mutex vs. Distributed Locking Guardrail

- **Context:** Implementing Part 2 concurrency controls for the checkout handler.
- **Original AI Action / Decision:**  
  The initial discussion considered presenting `AsyncKeyedMutex` as a generic "distributed lock" solution.
- **Why It Was Incorrect:**  
  An in-memory promise queue in Node.js only serializes concurrency within a **single OS process**. In a production cluster with multiple Node.js instances or containerized replicas, in-memory mutexes provide zero cross-instance protection and would still permit double-booking.
- **Corrective Candidate Steering / Intervention:**  
  - Enforced clear architectural separation: `AsyncKeyedMutex` implements an explicit interface `ILockManager`.
  - Added transparent documentation in [docs/SPEC.md](file:///e:/DEVELOPMENT/easyrent-test/docs/SPEC.md) and [docs/RCA.md](file:///e:/DEVELOPMENT/easyrent-test/docs/RCA.md) detailing the single-process boundary.
  - Authored a concrete production migration guide detailing how to replace the in-memory adapter with **Redis Redlock** or **PostgreSQL Advisory Locks** (`pg_advisory_xact_lock`) with partial unique constraints.
- **Verification Evidence:**  
  Documented in `docs/ARCHITECTURE_DECISIONS.md` (ADR 001) and Section 4 of `docs/RCA.md`.

---

## 3. Summary of Governance

| Issue | Category | Root Cause | Resolution | Automated Proof |
| :--- | :--- | :--- | :--- | :--- |
| **PowerShell `&&` Error** | Environment / CLI | OS terminal syntax discrepancy | Use `;` statement separator | Clean git commit history |
| **Missing Node Types** | Type Safety | Missing tsconfig type definition | Add `"types": ["node"]` | `npm run typecheck` passes |
| **VLAN 50 QoS Confusion** | Network Architecture | Overlapping rate limit specs | Separate per-client vs. aggregate shaper | `docs/NETWORK_ARCHITECTURE.md` |
| **Lock Scope Ambiguity** | System Architecture | Process-local vs. Distributed | Interface abstraction + Postgres/Redis blueprint | `tests/concurrency.test.ts` & `RCA.md` |
