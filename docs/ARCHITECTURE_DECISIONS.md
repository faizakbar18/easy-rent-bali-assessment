# Architecture Decision Records (ADR)

**Project:** Easy Rent Bali – Reliability Toolkit  
**Status:** Approved for Implementation  
**Standard:** RFC 2119 / Light Architectural Decision Format  

---

## ADR 001: In-Memory Asynchronous Per-Resource Locking Abstraction

### Context
In the Kuta Sunset Outage, concurrent kiosk retries for `car_avanza_04` caused database deadlocks because multiple concurrent processes attempted to read and write reservation state in conflicting lock order. For this assessment, we must demonstrate robust concurrency within Node.js without relying on an external database or Redis cluster.

### Decision
We introduce an explicit `ILockManager` interface with an in-memory `AsyncKeyedMutex` implementation:
- Locks are granular at the `vehicle_id` level (e.g. `lock:vehicle:car_avanza_04`).
- A promise chain queue serializes concurrent requests for the exact same vehicle without blocking requests for different vehicles.
- An automatic acquisition timeout (e.g. 2000ms) prevents infinite deadlocks.

```typescript
export interface ILockManager {
  acquire(resourceKey: string, ttlMs?: number): Promise<IDisposableLock>;
}
```

### Production Translation
In a multi-node production deployment, `AsyncKeyedMutex` is swapped with:
- **Redis Redlock / Redisson** with lease TTL.
- **PostgreSQL Advisory Locks** (`pg_advisory_xact_lock(hashtext(vehicle_id))`) scoped to the database transaction.

---

## ADR 002: Hold-Before-Capture Pattern & Compensation Lifecycle

### Context
During network instability, the legacy kiosk system attempted credit card capture *before* or *simultaneously with* acquiring a database lock. When the database transaction timed out or deadlocked, the credit card capture had already succeeded, leaving the customer charged but without a vehicle reservation.

### Decision
We mandate the **Hold-Before-Capture** lifecycle:
1. **Acquire Vehicle Lock:** Lock `vehicle_id`.
2. **Atomic Verification & Hold:** Check vehicle availability; transition status to `HELD` / `PENDING_PAYMENT` with a short hold TTL (e.g. 60 seconds).
3. **Release Vehicle Lock:** Lock is released before calling external payment provider to prevent holding database locks during high-latency network I/O.
4. **Idempotent Payment Capture:** Invoke payment gateway using `idempotency_key`.
5. **Re-acquire & Finalize:** Re-acquire lock to transition status to `CONFIRMED`.
6. **Compensating Transaction:** If payment fails or times out fatally, trigger immediate compensation (`RELEASE_HOLD`) to return vehicle status to `AVAILABLE`.

---

## ADR 003: Strict Content-Hashed Idempotency Store

### Context
Kiosks re-sent requests when network connections stuttered. Without an idempotency layer, every re-transmission was treated as a novel booking attempt.

### Decision
We implement an `IdempotencyManager` interface that records the lifecycle state of each unique key:
- **State Machine:** `IN_PROGRESS` $\rightarrow$ `COMPLETED` | `FAILED`.
- **Payload Hash Validation:** We compute a SHA-256 hash of the request payload (`booking_id`, `vehicle_id`, `customer_id`, `amount`).
  - If a subsequent request arrives with the **same key** and **identical payload**, the cached response is immediately returned (HTTP 200).
  - If a subsequent request arrives with the **same key** but **differing payload**, it is rejected with HTTP 409 / 422 (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
  - If a request is currently `IN_PROGRESS` when a duplicate arrives, it returns HTTP 409 (`REQUEST_IN_FLIGHT`).

### Production Translation
In production, this is backed by Redis key-value storage with atomic `SET key val NX EX 86400` or PostgreSQL `idempotency_records` table with a unique constraint on `idempotency_key`.

---

## ADR 004: Dual-WAN Failover Hysteresis & Emergency Bandwidth Shaping

### Context
The Kuta branch router experienced link flapping when cellular backup took over during the storm. High jitter and packet loss caused constant switching back and forth between dying fiber and cellular uplink. Furthermore, unthrottled guest Wi-Fi clients saturated the 10 Mbps cellular uplink, starving mission-critical POS and kiosk transactions.

### Decision
1. **Dual-Tier Probing:** Use two independent DNS/ICMP targets (`1.1.1.1` and `8.8.8.8`) plus an HTTP keep-alive probe to the cloud booking API.
2. **Fast Failover ($\le 3$s):** 1000ms ping interval, 3 consecutive lost packets triggers failover to WAN2.
3. **Flap Damping (Hysteresis):** Return to WAN1 requires 30 continuous seconds of sub-50ms ping with zero packet loss.
4. **Strict Dual-Tier QoS:**
   - **VLAN 20 (POS & Kiosks):** Tagged DSCP EF (46), reserved 5 Mbps guaranteed bandwidth on both WAN1 and WAN2.
   - **VLAN 50 (Guest Wi-Fi):** Normal operation permits 2 Mbps per client (aggregate up to 80 Mbps on 100 Mbps fiber). When WAN2 (Cellular) is active, VLAN 50 egress is throttled to $< 128\text{ kbps}$ aggregate or dropped completely to guarantee zero packet starvation for business operations.

---

## ADR 005: Decoupled Telemetry Rule Engine & Resilient Dispatcher

### Context
Fleet GPS gateways drop connections or send out-of-order telemetry during storms. Vehicle theft or unauthorized movement must be flagged with zero false positives for legitimate rental cars, while dispatching alerts must tolerate temporary communication failures.

### Decision
1. **Separation of Concerns:**
   - `TriageEngine`: Pure, deterministic evaluation of telemetry entries against business rules (`CRITICAL_SECURITY_ALERT`, `OFFLINE_TELEMETRY_DROP`, `MAINTENANCE_REQUIRED`). Preserves multiple concurrent violation reasons.
   - `AlertDispatcher`: Handles transmission, exponential backoff, random jitter, and deduplication.
2. **Exponential Backoff Formula:**
   $$\text{delay} = \min(\text{max\_backoff}, \text{base\_backoff} \times 2^{\text{attempt}}) + \text{random}(0, \text{jitter\_ms})$$
3. **Deduplication:** Debounce window ensures the same vehicle condition does not overwhelm operations with duplicate alert tickets.
