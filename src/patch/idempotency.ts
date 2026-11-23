/**
 * Easy Rent Bali - Reliability Toolkit
 * Idempotency Key Manager with Cryptographic Payload Hashing
 */

import { createHash } from 'node:crypto';

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord<T = unknown> {
  key: string;
  payloadHash: string;
  status: IdempotencyStatus;
  response?: T;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface IIdempotencyManager<T = unknown> {
  evaluate(
    key: string,
    payload: unknown
  ): Promise<{
    action: 'PROCEED' | 'SERVE_CACHED' | 'CONFLICT_IN_PROGRESS' | 'CONFLICT_PAYLOAD_MISMATCH';
    cachedResponse?: T;
  }>;
  recordSuccess(key: string, response: T): Promise<void>;
  recordFailure(key: string, errorMessage: string): Promise<void>;
  reset(): void;
}

/**
 * Creates deterministic SHA-256 hash of JSON payload
 */
export function computePayloadHash(payload: unknown): string {
  const canonicalString = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash('sha256').update(canonicalString).digest('hex');
}

export class InMemoryIdempotencyManager<T = unknown> implements IIdempotencyManager<T> {
  private store = new Map<string, IdempotencyRecord<T>>();

  reset(): void {
    this.store.clear();
  }

  async evaluate(
    key: string,
    payload: unknown
  ): Promise<{
    action: 'PROCEED' | 'SERVE_CACHED' | 'CONFLICT_IN_PROGRESS' | 'CONFLICT_PAYLOAD_MISMATCH';
    cachedResponse?: T;
  }> {
    const payloadHash = computePayloadHash(payload);
    const existing = this.store.get(key);

    if (!existing) {
      // First time seeing this key: mark IN_PROGRESS
      this.store.set(key, {
        key,
        payloadHash,
        status: 'IN_PROGRESS',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { action: 'PROCEED' };
    }

    // Existing key found: check payload hash
    if (existing.payloadHash !== payloadHash) {
      return { action: 'CONFLICT_PAYLOAD_MISMATCH' };
    }

    // Check status
    if (existing.status === 'IN_PROGRESS') {
      return { action: 'CONFLICT_IN_PROGRESS' };
    }

    if (existing.status === 'COMPLETED' && existing.response !== undefined) {
      return { action: 'SERVE_CACHED', cachedResponse: existing.response };
    }

    // Previous failed attempt: allow retry with same key & payload
    existing.status = 'IN_PROGRESS';
    existing.updatedAt = Date.now();
    return { action: 'PROCEED' };
  }

  async recordSuccess(key: string, response: T): Promise<void> {
    const record = this.store.get(key);
    if (record) {
      record.status = 'COMPLETED';
      record.response = response;
      record.updatedAt = Date.now();
    }
  }

  async recordFailure(key: string, errorMessage: string): Promise<void> {
    const record = this.store.get(key);
    if (record) {
      record.status = 'FAILED';
      record.error = errorMessage;
      record.updatedAt = Date.now();
    }
  }
}
