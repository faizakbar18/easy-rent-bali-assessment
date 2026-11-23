/**
 * Unit tests for CheckoutHandler and Idempotency
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
} from '../src/patch/checkout_handler.js';

describe('CheckoutHandler Unit & Idempotency Tests', () => {
  let repository: InMemoryVehicleRepository;
  let lockManager: AsyncKeyedMutex;
  let idempotencyManager: InMemoryIdempotencyManager<any>;
  let paymentGateway: MockPaymentGateway;
  let handler: CheckoutHandler;

  beforeEach(() => {
    repository = new InMemoryVehicleRepository([
      { id: 'car_avanza_01', plate: 'DK 1111 AA', model: 'Toyota Avanza', status: 'AVAILABLE' },
      { id: 'car_xpander_02', plate: 'DK 2222 BB', model: 'Mitsubishi Xpander', status: 'AVAILABLE' },
    ]);
    lockManager = new AsyncKeyedMutex();
    idempotencyManager = new InMemoryIdempotencyManager();
    paymentGateway = new MockPaymentGateway();
    handler = new CheckoutHandler(repository, lockManager, idempotencyManager, paymentGateway);
  });

  it('successfully completes a valid checkout with hold-then-capture', async () => {
    const request: CheckoutRequest = {
      booking_id: 'bk_001',
      vehicle_id: 'car_avanza_01',
      customer_id: 'cust_01',
      amount: 450000,
      idempotency_key: 'idemp_key_001',
    };

    const response = await handler.handleCheckout(request);

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('CONFIRMED');
    expect(response.body.booking_id).toBe('bk_001');
    expect(response.body.transaction_id).toBeDefined();

    // Verify repository state
    const vehicle = await repository.getVehicle('car_avanza_01');
    expect(vehicle?.status).toBe('RENTED');
    expect(vehicle?.currentBookingId).toBe('bk_001');

    const paymentCount = await repository.getCapturedPaymentsCount();
    expect(paymentCount).toBe(1);
  });

  it('replays cached response for repeated request with identical idempotency key and payload', async () => {
    const request: CheckoutRequest = {
      booking_id: 'bk_002',
      vehicle_id: 'car_avanza_01',
      customer_id: 'cust_02',
      amount: 450000,
      idempotency_key: 'idemp_key_002',
    };

    // First request
    const response1 = await handler.handleCheckout(request);
    expect(response1.statusCode).toBe(200);

    // Second request with same key & payload
    const response2 = await handler.handleCheckout(request);
    expect(response2.statusCode).toBe(200);
    expect(response2.body.idempotencyReplayed).toBe(true);
    expect(response2.body.transaction_id).toBe(response1.body.transaction_id);

    // Exactly one payment captured
    expect(await repository.getCapturedPaymentsCount()).toBe(1);
  });

  it('rejects with 409 conflict when same idempotency key is reused with different payload', async () => {
    const originalRequest: CheckoutRequest = {
      booking_id: 'bk_003',
      vehicle_id: 'car_avanza_01',
      customer_id: 'cust_03',
      amount: 450000,
      idempotency_key: 'idemp_key_reused',
    };

    const conflictingRequest: CheckoutRequest = {
      booking_id: 'bk_003_diff',
      vehicle_id: 'car_xpander_02', // Different vehicle!
      customer_id: 'cust_03',
      amount: 550000,
      idempotency_key: 'idemp_key_reused',
    };

    const response1 = await handler.handleCheckout(originalRequest);
    expect(response1.statusCode).toBe(200);

    const response2 = await handler.handleCheckout(conflictingRequest);
    expect(response2.statusCode).toBe(409);
    expect(response2.body.error).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('triggers compensation and releases vehicle hold if payment fails', async () => {
    const request: CheckoutRequest = {
      booking_id: 'bk_fail_01',
      vehicle_id: 'car_avanza_01',
      customer_id: 'cust_fail',
      amount: 450000,
      idempotency_key: 'idemp_fail_01',
    };

    const response = await handler.handleCheckout(request, { simulatePaymentFailure: true });

    expect(response.statusCode).toBe(402);
    expect(response.body.status).toBe('PAYMENT_FAILED');

    // Vehicle should have been released back to AVAILABLE via compensation
    const vehicle = await repository.getVehicle('car_avanza_01');
    expect(vehicle?.status).toBe('AVAILABLE');
    expect(vehicle?.currentBookingId).toBeUndefined();

    // No payments should be captured
    expect(await repository.getCapturedPaymentsCount()).toBe(0);
  });

  it('allows concurrent checkouts for different vehicles independently', async () => {
    const reqA: CheckoutRequest = {
      booking_id: 'bk_a',
      vehicle_id: 'car_avanza_01',
      customer_id: 'cust_a',
      amount: 450000,
      idempotency_key: 'key_a',
    };

    const reqB: CheckoutRequest = {
      booking_id: 'bk_b',
      vehicle_id: 'car_xpander_02',
      customer_id: 'cust_b',
      amount: 600000,
      idempotency_key: 'key_b',
    };

    const [resA, resB] = await Promise.all([
      handler.handleCheckout(reqA),
      handler.handleCheckout(reqB),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    expect(await repository.getCapturedPaymentsCount()).toBe(2);
  });
});
