/**
 * Easy Rent Bali - Reliability Toolkit
 * In-Memory Mock Repository & Asynchronous Lock Abstraction
 */

export type VehicleStatus = 'AVAILABLE' | 'HELD' | 'RENTED';
export type ReservationStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';

export interface Vehicle {
  id: string;
  plate: string;
  model: string;
  status: VehicleStatus;
  currentBookingId?: string;
  holdExpiresAt?: number;
}

export interface Reservation {
  bookingId: string;
  vehicleId: string;
  customerId: string;
  amount: number;
  status: ReservationStatus;
  createdAt: number;
  confirmedAt?: number;
}

export interface PaymentRecord {
  transactionId: string;
  bookingId: string;
  amount: number;
  idempotencyKey: string;
  status: 'CAPTURED' | 'FAILED';
  capturedAt: number;
}

/**
 * Disposable Lock interface allowing RAII pattern: using / finally { lock.release() }
 */
export interface IDisposableLock {
  release(): void;
}

/**
 * Abstract Lock Manager interface.
 * Can be swapped in production with Redis Redlock or Postgres Advisory Locks.
 */
export interface ILockManager {
  acquire(resourceKey: string, timeoutMs?: number): Promise<IDisposableLock>;
}

/**
 * In-Memory Keyed Asynchronous Mutex.
 * Serializes access to identical resource keys (e.g. `vehicle:car_avanza_04`)
 * while executing requests for different resource keys concurrently.
 */
export class AsyncKeyedMutex implements ILockManager {
  private lockQueues = new Map<string, Promise<void>>();

  async acquire(resourceKey: string, timeoutMs: number = 3000): Promise<IDisposableLock> {
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousLock = this.lockQueues.get(resourceKey) ?? Promise.resolve();
    // Update head of queue
    this.lockQueues.set(resourceKey, previousLock.then(() => currentLock));

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Lock acquisition timed out for resource: ${resourceKey}`));
      }, timeoutMs);
    });

    try {
      await Promise.race([previousLock, timeoutPromise]);
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      releaseLock();
      throw err;
    }

    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          releaseLock();
          // Clean up map entry if this was the last pending lock
          if (this.lockQueues.get(resourceKey) === currentLock) {
            this.lockQueues.delete(resourceKey);
          }
        }
      },
    };
  }
}

export interface IVehicleRepository {
  getVehicle(vehicleId: string): Promise<Vehicle | null>;
  holdVehicle(vehicleId: string, bookingId: string, customerId: string, amount: number, holdTtlSeconds?: number): Promise<Reservation>;
  confirmReservation(bookingId: string): Promise<Reservation>;
  releaseHold(bookingId: string): Promise<void>;
  getReservation(bookingId: string): Promise<Reservation | null>;
  getActiveReservationForVehicle(vehicleId: string): Promise<Reservation | null>;
  recordPayment(record: PaymentRecord): Promise<void>;
  getPaymentByBookingId(bookingId: string): Promise<PaymentRecord | null>;
  getCapturedPaymentsCount(): Promise<number>;
  seedVehicles(vehicles: Vehicle[]): void;
  reset(): void;
}

export class InMemoryVehicleRepository implements IVehicleRepository {
  private vehicles = new Map<string, Vehicle>();
  private reservations = new Map<string, Reservation>();
  private payments = new Map<string, PaymentRecord>();

  constructor(initialVehicles: Vehicle[] = []) {
    this.seedVehicles(initialVehicles);
  }

  seedVehicles(vehicles: Vehicle[]): void {
    for (const v of vehicles) {
      this.vehicles.set(v.id, { ...v });
    }
  }

  reset(): void {
    this.vehicles.clear();
    this.reservations.clear();
    this.payments.clear();
  }

  async getVehicle(vehicleId: string): Promise<Vehicle | null> {
    const v = this.vehicles.get(vehicleId);
    return v ? { ...v } : null;
  }

  async holdVehicle(
    vehicleId: string,
    bookingId: string,
    customerId: string,
    amount: number,
    holdTtlSeconds: number = 60
  ): Promise<Reservation> {
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle) {
      throw new Error(`Vehicle ${vehicleId} not found`);
    }

    // Check availability
    const now = Date.now();
    if (vehicle.status !== 'AVAILABLE') {
      // Check if previous hold has expired
      if (vehicle.status === 'HELD' && vehicle.holdExpiresAt && vehicle.holdExpiresAt < now) {
        // Expired hold, can be recycled
        if (vehicle.currentBookingId) {
          const oldRes = this.reservations.get(vehicle.currentBookingId);
          if (oldRes && oldRes.status === 'PENDING_PAYMENT') {
            oldRes.status = 'CANCELLED';
          }
        }
      } else {
        throw new Error(`Vehicle ${vehicleId} is already ${vehicle.status}`);
      }
    }

    // Atomic state update
    vehicle.status = 'HELD';
    vehicle.currentBookingId = bookingId;
    vehicle.holdExpiresAt = now + holdTtlSeconds * 1000;

    const reservation: Reservation = {
      bookingId,
      vehicleId,
      customerId,
      amount,
      status: 'PENDING_PAYMENT',
      createdAt: now,
    };
    this.reservations.set(bookingId, reservation);

    return { ...reservation };
  }

  async confirmReservation(bookingId: string): Promise<Reservation> {
    const res = this.reservations.get(bookingId);
    if (!res) {
      throw new Error(`Reservation ${bookingId} not found`);
    }

    const vehicle = this.vehicles.get(res.vehicleId);
    if (!vehicle) {
      throw new Error(`Vehicle ${res.vehicleId} not found for reservation ${bookingId}`);
    }

    res.status = 'CONFIRMED';
    res.confirmedAt = Date.now();

    vehicle.status = 'RENTED';
    vehicle.currentBookingId = bookingId;
    delete vehicle.holdExpiresAt;

    return { ...res };
  }

  async releaseHold(bookingId: string): Promise<void> {
    const res = this.reservations.get(bookingId);
    if (!res) return;

    if (res.status === 'PENDING_PAYMENT') {
      res.status = 'CANCELLED';
    }

    const vehicle = this.vehicles.get(res.vehicleId);
    if (vehicle && vehicle.currentBookingId === bookingId) {
      vehicle.status = 'AVAILABLE';
      delete vehicle.currentBookingId;
      delete vehicle.holdExpiresAt;
    }
  }

  async getReservation(bookingId: string): Promise<Reservation | null> {
    const res = this.reservations.get(bookingId);
    return res ? { ...res } : null;
  }

  async getActiveReservationForVehicle(vehicleId: string): Promise<Reservation | null> {
    for (const res of this.reservations.values()) {
      if (res.vehicleId === vehicleId && (res.status === 'CONFIRMED' || res.status === 'PENDING_PAYMENT')) {
        return { ...res };
      }
    }
    return null;
  }

  async recordPayment(record: PaymentRecord): Promise<void> {
    this.payments.set(record.bookingId, { ...record });
  }

  async getPaymentByBookingId(bookingId: string): Promise<PaymentRecord | null> {
    const p = this.payments.get(bookingId);
    return p ? { ...p } : null;
  }

  async getCapturedPaymentsCount(): Promise<number> {
    let count = 0;
    for (const p of this.payments.values()) {
      if (p.status === 'CAPTURED') count++;
    }
    return count;
  }
}
