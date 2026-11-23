# Root Cause Analysis (RCA) – The Kuta Sunset Outage

**Incident Title:** Kuta Sunset Checkout Deadlock & Duplicate Payment Storm  
**Incident Timestamp:** 2026-10-29T18:32:14.218+08:00 WITA  
**Impacted Service:** Branch Kiosk Checkout & Fleet Reservation Engine  
**Severity:** Critical (P1) – Direct Financial & Customer Impact  
**Author:** Lead DevOps & Infrastructure Reliability Engineer  
**Status:** Resolved via Architectural Patch  

---

## 1. Executive Summary & Captured Error Signature

During peak vehicle turnover at the Kuta Hub branch (18:30 WITA), a physical fiber severance forced a switchover to cellular backup (WAN2). High network latency (> 400ms) and dropped packets caused self-service kiosk HTTP calls to time out at the 5-second client timeout threshold.

The kiosk software immediately triggered automatic unthrottled retries for customer `cust_foreign_881` attempting to book `car_avanza_04`. This generated a burst of concurrent checkout requests across multiple backend worker processes, culminating in the following database engine crash:

```text
[2026-10-29T18:32:14.218+08:00] ERROR [CheckoutWorker] TransactionRollbackError: deadlock detected
Process 9182 waits for ExclusiveLock on relation 'vehicle_reservations'; blocked by process 9188.
Process 9188 waits for ExclusiveLock on relation 'vehicles'; blocked by process 9182.
Payload: { "booking_id": "erb_kuta_9941", "vehicle_id": "car_avanza_04", "customer_id": "cust_foreign_881" }
```

Simultaneously, the payment gateway logs confirmed that customer `cust_foreign_881` was charged **three times** ($3 \times \text{IDR } 450,000$), yet the vehicle remained locked and unreserved in the database.

---

## 2. In-Depth Root Cause Analysis

### 2.1 Why Kiosk Retries Caused Transactional Deadlocks
A database deadlock requires four Coffman conditions: mutual exclusion, hold and wait, no preemption, and **circular wait**. The legacy checkout worker suffered from an inconsistent lock ordering antipattern:

```mermaid
sequenceDiagram
    autonumber
    participant Kiosk as Self-Service Kiosk
    participant P9182 as Worker Process 9182 (Retry 1)
    participant P9188 as Worker Process 9188 (Retry 2)
    participant DB as PostgreSQL Database

    Note over Kiosk: Kiosk times out at 5s; initiates aggressive retry
    Kiosk->>P9182: POST /checkout (Request 1)
    Kiosk->>P9188: POST /checkout (Request 2)

    P9182->>DB: BEGIN TRANSACTION
    P9188->>DB: BEGIN TRANSACTION

    P9182->>DB: UPDATE vehicles SET status='HELD' WHERE id='car_avanza_04'
    Note over DB: Process 9182 acquires RowExclusiveLock on 'vehicles'

    P9188->>DB: INSERT INTO vehicle_reservations (booking_id, ...)
    Note over DB: Process 9188 acquires RowExclusiveLock on 'vehicle_reservations'

    P9182->>DB: INSERT INTO vehicle_reservations (booking_id, ...)
    Note over DB: Process 9182 WAITS for Process 9188 to release 'vehicle_reservations'

    P9188->>DB: UPDATE vehicles SET status='HELD' WHERE id='car_avanza_04'
    Note over DB: Process 9188 WAITS for Process 9182 to release 'vehicles'

    rect rgb(255, 230, 230)
    Note over DB: CIRCULAR WAIT DETECTED!<br>Postgres deadlock_timeout (1000ms) expires.<br>Process 9182 is forcefully rolled back with TransactionRollbackError.
    end
```

**Key Flaws:**
1. **Lack of Deterministic Lock Acquisition Ordering:** Process 9182 locked `vehicles` then sought `vehicle_reservations`. Process 9188 inserted into `vehicle_reservations` before updating `vehicles`.
2. **Missing Distributed Idempotency:** The backend did not check whether a request for `(booking_id: "erb_kuta_9941", vehicle_id: "car_avanza_04")` was already being executed by another thread.

### 2.2 Why Duplicate Payments Were Captured Without Confirmed Holds
The legacy code executed payment capture before database transaction commit:

```typescript
// ❌ CRITICAL ANTIPATTERN (LEGACY WORKER)
async function legacyCheckout(req) {
  // 1. Payment charged FIRST over high-latency network
  const payment = await paymentGateway.chargeCard(req.amount); // SUCCESS
  
  // 2. Database transaction attempted AFTER payment
  await db.transaction(async (trx) => {
    await trx('vehicle_reservations').insert(...); // THROWS DEADLOCK ROLLBACK
  });
  // Result: Money taken from customer, vehicle never reserved!
}
```

When network latency spiked during the storm:
1. The payment gateway call took 3.5 seconds to succeed.
2. The kiosk timed out at 5.0 seconds and immediately sent a retry request.
3. The retry request called the payment gateway again with a new random charge reference, capturing payment a second time.
4. When both processes finally attempted database writes, they deadlocked and rolled back. The customer was charged twice, and the car remained unavailable.

---

## 3. The Architectural Solution: Thread-Safe & Idempotent API Patch

The new reliability patch ([src/patch/checkout_handler.ts](file:///e:/DEVELOPMENT/easyrent-test/src/patch/checkout_handler.ts)) implements four protective tiers:

### 3.1 Tier 1: Cryptographic Idempotency Store
- Incoming requests supply an `idempotency_key`.
- The system computes a canonical SHA-256 hash of the payload (`booking_id`, `vehicle_id`, `customer_id`, `amount`).
- **If key is known and payload is identical:** Returns cached HTTP 200 response immediately without calling the database or payment provider.
- **If key is currently in-flight:** Returns HTTP 409 (`REQUEST_IN_FLIGHT`).
- **If key is reused with a different payload:** Returns HTTP 409 (`IDEMPOTENCY_PAYLOAD_MISMATCH`).

### 3.2 Tier 2: Per-Vehicle Asynchronous Lock (`AsyncKeyedMutex`)
- Rather than coarse global locking or contending at the database table level, locking is isolated to the specific vehicle: `lock:vehicle:{vehicle_id}`.
- Requests competing for `car_avanza_04` are queued sequentially, eliminating deadlocks. Requests for `car_xpander_02` execute in parallel without obstruction.

### 3.3 Tier 3: Hold-Before-Capture Pattern
- The vehicle state transition from `AVAILABLE` $\rightarrow$ `HELD` is validated and committed **before** calling the external payment gateway.
- If another request already holds or rents the car, the request immediately terminates with HTTP 409 (`VEHICLE_ALREADY_RESERVED`). Zero payment calls are made.

### 3.4 Tier 4: Automated Saga Compensation
- If the payment provider fails or times out, the handler triggers an immediate compensating transaction: `repository.releaseHold(bookingId)`, restoring the vehicle to `AVAILABLE` for other customers.

---

## 4. Production Architecture Mapping & Limitations

### 4.1 In-Memory Mock vs. Multi-Instance Production Deployment
The current implementation runs entirely in-memory using TypeScript and Node.js for zero-setup local execution and deterministic Vitest testing:

| Component | In-Memory Assessment Implementation | Production Multi-Instance Architecture |
| :--- | :--- | :--- |
| **Locking Mechanism** | `AsyncKeyedMutex` (Process-local Promise chain queue) | **Redis Redlock** cluster or **PostgreSQL Advisory Locks** (`pg_advisory_xact_lock(hashtext(vehicle_id))`) |
| **Idempotency Store** | `InMemoryIdempotencyManager` (`Map<string, IdempotencyRecord>`) | **Redis Key-Value** with atomic `SET key val NX EX 86400` or PostgreSQL `idempotency_keys` table |
| **Database Transaction** | `InMemoryVehicleRepository` atomic JS state mutations | **PostgreSQL** with `SELECT ... FOR UPDATE` and partial unique index |
| **Payment Provider** | `MockPaymentGateway` with deterministic latency | Payment gateway (Stripe/Xendit) utilizing `Idempotency-Key` HTTP headers |

### 4.2 Production PostgreSQL Schema & Locking Pattern
In production PostgreSQL, circular deadlocks are eradicated by enforcing a strict top-down lock hierarchy:

```sql
-- 1. Enforce physical exclusion constraint preventing double booking
CREATE TABLE vehicle_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id VARCHAR(64) UNIQUE NOT NULL,
    vehicle_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Partial unique index ensures only ONE active reservation exists per vehicle at any time
CREATE UNIQUE INDEX idx_unique_active_vehicle_res 
ON vehicle_reservations (vehicle_id) 
WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

-- 2. Transactional checkout function with explicit lock ordering
BEGIN;
  -- Lock vehicle row first (guarantees identical lock ordering across all workers)
  SELECT id, status FROM vehicles 
  WHERE id = 'car_avanza_04' AND status = 'AVAILABLE' 
  FOR UPDATE;

  -- Insert reservation in HELD / PENDING_PAYMENT state
  INSERT INTO vehicle_reservations (booking_id, vehicle_id, customer_id, status)
  VALUES ('erb_kuta_9941', 'car_avanza_04', 'cust_foreign_881', 'PENDING_PAYMENT');
COMMIT;

-- External payment is executed OUTSIDE database transaction
-- Upon payment success:
UPDATE vehicle_reservations SET status = 'CONFIRMED' WHERE booking_id = 'erb_kuta_9941';
UPDATE vehicles SET status = 'RENTED' WHERE id = 'car_avanza_04';
```
