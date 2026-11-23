# System Specification & Technical Contract (SPEC.md)

**Project:** Easy Rent Bali – Infrastructure, Concurrency & Fleet Reliability Toolkit  
**Assessment Track:** Option C (Incident Response, Network Failover & Fleet Triage)  
**Environment:** Windows 11 | Node.js v22+ | TypeScript 5+ | Vitest  
**Status:** DRAFT / PENDING REVIEW  

---

## 1. Problem Statement & Incident Context

### The Kuta Sunset Outage (Peak Turnover – 18:30 WITA)
During a severe thunderstorm at Kuta Hub, the primary fiber uplink was physically severed. The gateway initiated failover to a secondary cellular backup, but unstable conditions (high jitter > 400ms, 18% packet loss, link flapping) triggered cascading system failures across three tiers:

1. **Self-Service Kiosks:**  
   Customer checkout requests timed out due to network latency and dropped packets. Aggressive automatic kiosk retries flooded backend workers. This caused concurrent checkout transactions on the same vehicle (`car_avanza_04`), triggering PostgreSQL transactional deadlocks (`ExclusiveLock` on `vehicle_reservations`) while duplicate payment transactions were captured before vehicle holds were confirmed.
2. **Branch Network:**  
   Unthrottled guest Wi-Fi clients saturated the constrained cellular backup uplink, starving critical POS terminals, kiosk transactions, and cloud controller keep-alive heartbeats.
3. **Fleet Operations:**  
   The branch IoT telemetry gateway suffered dropped connections and intermittent reporting, leaving returning rental vehicles untracked, offline, or moving without proper authorization.

---

## 2. Architecture & Deliverables Matrix

| Subsystem | Assessment Scope | Key Components / Artifacts | Verification Method |
| :--- | :--- | :--- | :--- |
| **Part 1: Branch Infrastructure** | Network Architecture & Failover | `docs/NETWORK_ARCHITECTURE.md` | Policy audit, Mermaid syntax check, QoS & IP verification |
| **Part 2: Concurrency & API** | Thread-Safe Checkout & Idempotency | `src/patch/checkout_handler.ts`<br>`src/patch/mock_repository.ts`<br>`src/patch/idempotency.ts`<br>`docs/RCA.md` | Vitest concurrency suite (5 concurrent requests $\rightarrow$ 1 success, 4 HTTP 409) |
| **Part 3: Fleet Self-Healing** | Telemetry Triage & Resilient Dispatch | `src/engine/types.ts`<br>`src/engine/triage_engine.ts`<br>`src/engine/dispatcher.ts`<br>`output/incident_reconciliation.json` | 8-vehicle telemetry test, retry/jitter test, incident output verification |
| **AI Steering & Governance** | AI Traceability & Log Preservations | `ai_session_logs/STEERING_AUDIT.md`<br>`ai_session_logs/raw_logs/` | Real audit of at least 2 AI missteps and corrections |

---

## 3. Subsystem Specifications

### Part 1: Branch Infrastructure & Failover Architecture

1. **Network Topology:**  
   - Kuta Hub local infrastructure (Core Gateway/Router, Managed PoE Switch, APs, POS terminals, Kiosks, IoT Gateway, CCTV).
   - Dual-WAN connectivity: Primary Fiber WAN1 (active) and Secondary Cellular LTE/5G WAN2 (hot-standby).
   - Secure IPSec / WireGuard Site-to-Site tunnel to HQ Renon.
   - Secure outbound TLS/HTTPS tunnels to Cloud Management & Payment Services.
2. **802.1Q VLAN Segmentation:**
   - **VLAN 10 (Management):** `10.10.10.0/24`, Gateway `.1`, DHCP `.10-.50`, strictly isolated from all client VLANs.
   - **VLAN 20 (POS & Kiosks):** `10.10.20.0/24`, Gateway `.1`, DHCP `.10-.100`, DSCP EF (46) queue priority, isolated to payment/booking API endpoints only.
   - **VLAN 30 (Staff):** `10.10.30.0/24`, Gateway `.1`, DHCP `.10-.200`, restricted internal operational access and filtered outbound web.
   - **VLAN 40 (Fleet IoT & CCTV):** `10.10.40.0/24`, Gateway `.1`, DHCP `.10-.200`, no public internet ingress; outbound restricted to IoT cloud ingestion endpoint; CCTV local NVR access only.
   - **VLAN 50 (Guest Wi-Fi):** `172.16.50.0/22`, Gateway `.1`, DHCP `.10-172.16.53.250`, client-to-client isolation (private VLAN / guest mode). Normal operation: hard rate limit of 2 Mbps per client.
3. **Dual-WAN Failover & Traffic Shaping Policy:**
   - **Health Checks:** Multi-target ICMP/HTTP synthetic probes (`8.8.8.8`, `1.1.1.1`, cloud controller endpoint) every 1000ms.
   - **Trigger Threshold:** $\ge 3$ consecutive packet drop cycles or jitter $> 300\text{ms}$ (total detection $< 3\text{s}$).
   - **Hysteresis:** Failback to WAN1 requires 30 consecutive seconds of stable ping before re-routing to prevent route flapping during storm brownouts.
   - **WAN2 Emergency Bandwidth Policy:** When active WAN is WAN2 (cellular), enforce strict aggregate queue limit on VLAN 50 ($< 128\text{ kbps}$ aggregate) or blackhole guest traffic, preserving $100\%$ capacity for POS, Kiosks, and IoT heartbeats.

---

### Part 2: Concurrency & Idempotent API Patch

1. **Functional Flow:**  
   A checkout request provides:
   - `booking_id`: string (e.g. `erb_kuta_9941`)
   - `vehicle_id`: string (e.g. `car_avanza_04`)
   - `customer_id`: string (e.g. `cust_foreign_881`)
   - `idempotency_key`: string (UUID or client-supplied unique token)
   - `amount`: number
2. **Idempotency Invariants:**
   - Same `idempotency_key` + same payload: Returns previously saved HTTP 200 response without re-processing booking or re-capturing payment.
   - Same `idempotency_key` + differing payload: Rejects with HTTP 422 / 409 (payload mismatch error).
   - In-flight request with same key: Queued or returns 409 Concurrent in progress.
3. **Vehicle Locking & Atomic Hold:**
   - **Locking Scope:** Per-`vehicle_id` granular asynchronous mutex lock.
   - **Hold-Before-Capture Invariant:** Vehicle status must transition from `AVAILABLE` $\rightarrow$ `RESERVED` atomically in the repository *before* any payment provider API is invoked.
   - **Failure Compensation:** If payment capture fails or times out, an automated compensation transaction releases the vehicle reservation back to `AVAILABLE`.
4. **Concurrency Acceptance Criteria:**
   - Executing 5 concurrent requests with distinct `idempotency_key` targeting the same available vehicle (`car_avanza_04`) must result in:
     - Exactly **1 success** (HTTP 200, status `CONFIRMED`, payment captured).
     - Exactly **4 conflicts** (HTTP 409, status `VEHICLE_ALREADY_RESERVED`).
     - Exactly **1 active reservation** in the repository.
     - Exactly **1 payment capture**.

---

### Part 3: Real-Time Fleet & Network Self-Healing Engine

1. **Dataset:** Ingestion of 8 vehicles from `data/outage_telemetry.json`.
2. **Rule Evaluation Engine:**
   - **Rule 1 (`CRITICAL_SECURITY_ALERT`):**  
     `status == "available" && current_speed_kmh > 0`  
     **OR**  
     `current_location.zone` is present in `RESTRICTED_ZONES` (e.g. `RESTRICTED_OFFROAD_BATUKARU`).
   - **Rule 2 (`OFFLINE_TELEMETRY_DROP`):**  
     `status == "rented" && last_ping_seconds_ago > 900` (15 minutes).
   - **Rule 3 (`MAINTENANCE_REQUIRED`):**  
     `battery_voltage < 11.5` **OR** `fuel_percent < 15`.  
     *Requirement:* If both conditions are met, **both reasons must be preserved** in the alert payload.
3. **Resilient Dispatcher:**
   - **Backoff & Jitter:** Exponential backoff $T_{wait} = \min(T_{max}, T_{base} \times 2^{attempt}) + \text{jitter}(0, 50\text{ms})$.
   - **Retry Bounds:** Up to 3 retries for transient errors. Permanent errors fail fast.
   - **Deduplication:** Repeated incidents for the same device within the debounce window are suppressed.
   - **Reconciliation Output:** Generates `output/incident_reconciliation.json` with execution status, retry counts, and timestamped payloads.
4. **Starter Fleet Expected Baseline:**
   - `iot_car_01`: Normal rented moving $\rightarrow$ **NO INCIDENT**
   - `iot_car_02`: Available moving ($52\text{ km/h}$) $\rightarrow$ **CRITICAL_SECURITY_ALERT**
   - `iot_car_03`: Rented, battery $11.2\text{V} < 11.5\text{V}$ $\rightarrow$ **MAINTENANCE_REQUIRED**
   - `iot_car_04`: Rented, fuel $9\% < 15\%$ $\rightarrow$ **MAINTENANCE_REQUIRED**
   - `iot_car_05`: Rented in `RESTRICTED_OFFROAD_BATUKARU` $\rightarrow$ **CRITICAL_SECURITY_ALERT**
   - `iot_car_06`: Rented, silent $1320\text{s} > 900\text{s}$ $\rightarrow$ **OFFLINE_TELEMETRY_DROP**
   - `iot_car_07`: Available, static, healthy $\rightarrow$ **NO INCIDENT**
   - `iot_car_08`: Available, battery $11.3\text{V}$ AND fuel $11\%$ $\rightarrow$ **MAINTENANCE_REQUIRED** (2 reasons preserved)

---

## 4. Ambiguities & Technical Risks

| # | Ambiguity / Risk | Architectural Assumption / Mitigation |
| :--- | :--- | :--- |
| **R1** | Single Node.js process vs. Distributed System | The assessment requires a mock in-memory repository without Redis/Postgres. We must implement asynchronous memory mutexes and explicitly document that this demonstrates single-process concurrency, while abstracting the interface (`IVehicleLock`, `IRepository`) so it maps directly to Redis Redlock or Postgres `SELECT FOR UPDATE`. |
| **R2** | Normal Guest Wi-Fi vs. WAN2 Emergency Shaping | Normal QoS per client is $2\text{ Mbps}$. On WAN2 failover, the limit is $< 128\text{ kbps}$ aggregate. We must make sure documentation clearly distinguishes per-client policing from emergency aggregate egress shaping. |
| **R3** | Payment Network Timeouts vs. Double Capture | Network timeout does not mean payment failed. The patch must simulate idempotency on the payment gateway adapter, ensuring payment calls are only issued after reservation hold and accept an `idempotency_key`. |
| **R4** | Telemetry Deduplication Window | If a car repeatedly reports offline or low battery every 10 seconds, the dispatcher must not spam notifications. We establish an in-memory deduplication/debounce registry based on `(device_id, incident_type)`. |

---

## 5. Verification Commands

```powershell
npm run typecheck    # Strict TypeScript verification
npm test             # Vitest concurrency, unit & integration tests
npm run build        # Compiles to /dist
npm run assessment   # Executes end-to-end telemetry triage and outputs incident_reconciliation.json
```
