/**
 * Easy Rent Bali - Reliability Toolkit
 * Mandatory Concurrency Test: 5 Simultaneous Requests Against Single Vehicle
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryVehicleRepository,
  AsyncKeyedMutex,
} from '../src/patch/mock_repository.js';
import { InMemoryIdempotencyManager } from '../src/patch/idempotency.js';
import {
  CheckoutHandler,
  MockPaymentGateway,
  CheckoutRequest,
  CheckoutResponse,
} from '../src/patch/checkout_handler.js';

describe('Mandatory Concurrency Suite (The Kuta Sunset Outage Simulation)', () => {
  let repository: InMemoryVehicleRepository;
  let lockManager: AsyncKeyedMutex;
  let idempotencyManager: InMemoryIdempotencyManager<any>;
  let paymentGateway: MockPaymentGateway;
  let handler: CheckoutHandler;

  beforeEach(() => {
    // Exact vehicle from the incident report
    repository = new InMemoryVehicleRepository([
      {
        id: 'car_avanza_04',
        plate: 'DK 3456 GH',
        model: 'Toyota Avanza',
        status: 'AVAILABLE',
      },
    ]);
    lockManager = new AsyncKeyedMutex();
    idempotencyManager = new InMemoryIdempotencyManager();
    paymentGateway = new MockPaymentGateway();
    handler = new CheckoutHandler(repository, lockManager, idempotencyManager, paymentGateway);
  });

  it('proves exactly 1 successful checkout and 4 graceful HTTP 409 conflicts under 5 simultaneous requests', async () => {
    const TARGET_VEHICLE_ID = 'car_avanza_04';

    // 5 concurrent requests representing kiosk retries and competing customers
    const concurrentRequests: CheckoutRequest[] = [
      {
        booking_id: 'erb_kuta_9941_r1',
        vehicle_id: TARGET_VEHICLE_ID,
        customer_id: 'cust_foreign_881',
        amount: 450000,
        idempotency_key: 'idemp_req_kiosk_01',
      },
      {
        booking_id: 'erb_kuta_9941_r2',
        vehicle_id: TARGET_VEHICLE_ID,
        customer_id: 'cust_foreign_881',
        amount: 450000,
        idempotency_key: 'idemp_req_kiosk_02',
      },
      {
        booking_id: 'erb_kuta_9941_r3',
        vehicle_id: TARGET_VEHICLE_ID,
        customer_id: 'cust_foreign_881',
        amount: 450000,
        idempotency_key: 'idemp_req_kiosk_03',
      },
      {
        booking_id: 'erb_kuta_9941_r4',
        vehicle_id: TARGET_VEHICLE_ID,
        customer_id: 'cust_foreign_881',
        amount: 450000,
        idempotency_key: 'idemp_req_kiosk_04',
      },
      {
        booking_id: 'erb_kuta_9941_r5',
        vehicle_id: TARGET_VEHICLE_ID,
        customer_id: 'cust_foreign_881',
        amount: 450000,
        idempotency_key: 'idemp_req_kiosk_05',
      },
    ];

    // Fire all 5 requests simultaneously into the Node.js event loop
    const results: CheckoutResponse[] = await Promise.all(
      concurrentRequests.map((req) =>
        handler.handleCheckout(req, { paymentLatencyMs: 25 })
      )
    );

    // Filter responses by status code
    const successfulResponses = results.filter((r) => r.statusCode === 200);
    const conflictResponses = results.filter((r) => r.statusCode === 409);

    // CRITICAL ACCEPTANCE CRITERIA 1: Exactly 1 success (HTTP 200)
    expect(successfulResponses).toHaveLength(1);
    expect(successfulResponses[0].body.status).toBe('CONFIRMED');
    expect(successfulResponses[0].body.vehicle_id).toBe(TARGET_VEHICLE_ID);
    expect(successfulResponses[0].body.transaction_id).toBeDefined();

    // CRITICAL ACCEPTANCE CRITERIA 2: Exactly 4 graceful conflicts (HTTP 409)
    expect(conflictResponses).toHaveLength(4);
    for (const conflict of conflictResponses) {
      expect(conflict.body.status).toBe('CONFLICT');
      expect(conflict.body.error).toBe('VEHICLE_ALREADY_RESERVED');
    }

    // CRITICAL ACCEPTANCE CRITERIA 3: Exactly 1 active reservation in repository
    const activeReservation = await repository.getActiveReservationForVehicle(TARGET_VEHICLE_ID);
    expect(activeReservation).not.toBeNull();
    expect(activeReservation?.status).toBe('CONFIRMED');
    expect(activeReservation?.bookingId).toBe(successfulResponses[0].body.booking_id);

    // CRITICAL ACCEPTANCE CRITERIA 4: Zero duplicate payment captures
    const totalCapturedPayments = await repository.getCapturedPaymentsCount();
    expect(totalCapturedPayments).toBe(1);
    expect(paymentGateway.getCapturedCount()).toBe(1);

    // Final vehicle state must be RENTED
    const finalVehicle = await repository.getVehicle(TARGET_VEHICLE_ID);
    expect(finalVehicle?.status).toBe('RENTED');
    expect(finalVehicle?.currentBookingId).toBe(successfulResponses[0].body.booking_id);
  });
});
