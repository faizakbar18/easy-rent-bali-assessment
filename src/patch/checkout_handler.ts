/**
 * Easy Rent Bali - Reliability Toolkit
 * Thread-Safe & Idempotent Checkout Handler
 */

import {
  ILockManager,
  IVehicleRepository,
  AsyncKeyedMutex,
  InMemoryVehicleRepository,
} from './mock_repository.js';
import {
  IIdempotencyManager,
  InMemoryIdempotencyManager,
} from './idempotency.js';

export interface CheckoutRequest {
  booking_id: string;
  vehicle_id: string;
  customer_id: string;
  amount: number;
  idempotency_key: string;
}

export interface CheckoutResponseBody {
  success: boolean;
  status: 'CONFIRMED' | 'CONFLICT' | 'PAYMENT_FAILED' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  message: string;
  booking_id?: string;
  vehicle_id?: string;
  customer_id?: string;
  transaction_id?: string;
  error?: string;
  idempotencyReplayed?: boolean;
}

export interface CheckoutResponse {
  statusCode: number;
  body: CheckoutResponseBody;
}

export interface IPaymentGateway {
  charge(
    bookingId: string,
    amount: number,
    idempotencyKey: string,
    simulateFailure?: boolean,
    latencyMs?: number
  ): Promise<{ success: boolean; transactionId?: string; error?: string }>;
}

export class MockPaymentGateway implements IPaymentGateway {
  private capturedTransactions = new Map<string, { transactionId: string; amount: number }>();

  async charge(
    bookingId: string,
    amount: number,
    idempotencyKey: string,
    simulateFailure: boolean = false,
    latencyMs: number = 20
  ): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    // Artificial payment network delay simulation
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    if (simulateFailure) {
      return { success: false, error: 'INSUFFICIENT_FUNDS_OR_NETWORK_ERROR' };
    }

    // Idempotent payment check
    const existing = this.capturedTransactions.get(idempotencyKey);
    if (existing) {
      return { success: true, transactionId: existing.transactionId };
    }

    const transactionId = `txn_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    this.capturedTransactions.set(idempotencyKey, { transactionId, amount });

    return { success: true, transactionId };
  }

  getCapturedCount(): number {
    return this.capturedTransactions.size;
  }

  reset(): void {
    this.capturedTransactions.clear();
  }
}

export class CheckoutHandler {
  constructor(
    private readonly repository: IVehicleRepository,
    private readonly lockManager: ILockManager = new AsyncKeyedMutex(),
    private readonly idempotencyManager: IIdempotencyManager<CheckoutResponse> = new InMemoryIdempotencyManager<CheckoutResponse>(),
    private readonly paymentGateway: IPaymentGateway = new MockPaymentGateway()
  ) {}

  async handleCheckout(
    request: CheckoutRequest,
    options: { simulatePaymentFailure?: boolean; paymentLatencyMs?: number } = {}
  ): Promise<CheckoutResponse> {
    // 1. Payload validation
    if (!request.booking_id || !request.vehicle_id || !request.customer_id || !request.idempotency_key) {
      return {
        statusCode: 422,
        body: {
          success: false,
          status: 'VALIDATION_ERROR',
          message: 'Missing required checkout fields (booking_id, vehicle_id, customer_id, idempotency_key).',
          error: 'UNPROCESSABLE_ENTITY',
        },
      };
    }

    if (typeof request.amount !== 'number' || request.amount <= 0) {
      return {
        statusCode: 422,
        body: {
          success: false,
          status: 'VALIDATION_ERROR',
          message: 'Amount must be a positive number.',
          error: 'INVALID_AMOUNT',
        },
      };
    }

    // 2. Strict Idempotency Check
    const { action, cachedResponse } = await this.idempotencyManager.evaluate(
      request.idempotency_key,
      {
        booking_id: request.booking_id,
        vehicle_id: request.vehicle_id,
        customer_id: request.customer_id,
        amount: request.amount,
      }
    );

    if (action === 'SERVE_CACHED' && cachedResponse) {
      return {
        ...cachedResponse,
        body: {
          ...cachedResponse.body,
          idempotencyReplayed: true,
        },
      };
    }

    if (action === 'CONFLICT_PAYLOAD_MISMATCH') {
      return {
        statusCode: 409,
        body: {
          success: false,
          status: 'CONFLICT',
          message: 'Idempotency key previously used with a different request payload.',
          error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        },
      };
    }

    if (action === 'CONFLICT_IN_PROGRESS') {
      return {
        statusCode: 409,
        body: {
          success: false,
          status: 'CONFLICT',
          message: 'Concurrent request with the same idempotency key is currently being processed.',
          error: 'REQUEST_IN_FLIGHT',
        },
      };
    }

    // 3. Granular per-vehicle asynchronous lock acquisition
    const lockKey = `lock:vehicle:${request.vehicle_id}`;
    const vehicleLock = await this.lockManager.acquire(lockKey, 4000);

    let vehicleHeld = false;
    try {
      // 4. Atomic vehicle check and hold
      try {
        await this.repository.holdVehicle(
          request.vehicle_id,
          request.booking_id,
          request.customer_id,
          request.amount,
          60 // 60 seconds hold
        );
        vehicleHeld = true;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const conflictResponse: CheckoutResponse = {
          statusCode: 409,
          body: {
            success: false,
            status: 'CONFLICT',
            message: `Vehicle ${request.vehicle_id} is unavailable for reservation.`,
            error: 'VEHICLE_ALREADY_RESERVED',
          },
        };
        await this.idempotencyManager.recordFailure(request.idempotency_key, errorMsg);
        return conflictResponse;
      }
    } finally {
      // Release lock BEFORE executing network payment I/O to avoid holding DB lock
      vehicleLock.release();
    }

    // 5. Simulated Payment Capture (Guaranteed after vehicle hold)
    const paymentResult = await this.paymentGateway.charge(
      request.booking_id,
      request.amount,
      request.idempotency_key,
      options.simulatePaymentFailure ?? false,
      options.paymentLatencyMs ?? 15
    );

    if (!paymentResult.success) {
      // 6. Payment Compensation: Re-acquire lock to release vehicle hold
      const compLock = await this.lockManager.acquire(lockKey, 4000);
      try {
        await this.repository.releaseHold(request.booking_id);
      } finally {
        compLock.release();
      }

      const failResponse: CheckoutResponse = {
        statusCode: 402,
        body: {
          success: false,
          status: 'PAYMENT_FAILED',
          message: 'Payment capture failed. Vehicle hold has been released.',
          error: paymentResult.error ?? 'PAYMENT_CAPTURE_ERROR',
        },
      };
      await this.idempotencyManager.recordFailure(request.idempotency_key, failResponse.body.message);
      return failResponse;
    }

    // 7. Re-acquire lock to finalize and confirm reservation
    const confirmLock = await this.lockManager.acquire(lockKey, 4000);
    try {
      await this.repository.recordPayment({
        transactionId: paymentResult.transactionId!,
        bookingId: request.booking_id,
        amount: request.amount,
        idempotencyKey: request.idempotency_key,
        status: 'CAPTURED',
        capturedAt: Date.now(),
      });
      await this.repository.confirmReservation(request.booking_id);
    } finally {
      confirmLock.release();
    }

    // 8. Build success response & cache in idempotency manager
    const successResponse: CheckoutResponse = {
      statusCode: 200,
      body: {
        success: true,
        status: 'CONFIRMED',
        message: 'Vehicle checkout confirmed successfully.',
        booking_id: request.booking_id,
        vehicle_id: request.vehicle_id,
        customer_id: request.customer_id,
        transaction_id: paymentResult.transactionId,
      },
    };

    await this.idempotencyManager.recordSuccess(request.idempotency_key, successResponse);
    return successResponse;
  }
}
