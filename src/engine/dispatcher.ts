/**
 * Easy Rent Bali - Fleet Reliability Toolkit
 * Resilient Alert Dispatcher with Exponential Backoff & Jitter
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  FleetIncident,
  ReconciliationRecord,
  DispatchStatus,
  DispatcherConfig,
} from './types.js';

export class DispatchError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean = true,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface INotificationAdapter {
  sendAlert(incident: FleetIncident): Promise<{ success: boolean; error?: string }>;
}

export class MockNotificationAdapter implements INotificationAdapter {
  private callCountMap = new Map<string, number>();
  private failurePlan = new Map<string, { failUntilAttempt: number; isRetryable: boolean }>();

  /**
   * Plans simulated failures for testing retry loops
   */
  planFailure(incidentId: string, failUntilAttempt: number, isRetryable: boolean = true): void {
    this.failurePlan.set(incidentId, { failUntilAttempt, isRetryable });
  }

  async sendAlert(incident: FleetIncident): Promise<{ success: boolean; error?: string }> {
    const current = (this.callCountMap.get(incident.incident_id) ?? 0) + 1;
    this.callCountMap.set(incident.incident_id, current);

    const plan = this.failurePlan.get(incident.incident_id);
    if (plan && current <= plan.failUntilAttempt) {
      if (!plan.isRetryable) {
        throw new DispatchError(`Fatal non-retryable endpoint error for ${incident.incident_id}`, false, 400);
      }
      throw new DispatchError(`Simulated network failure on attempt ${current}`, true, 503);
    }

    return { success: true };
  }

  getAttempts(incidentId: string): number {
    return this.callCountMap.get(incidentId) ?? 0;
  }

  reset(): void {
    this.callCountMap.clear();
    this.failurePlan.clear();
  }
}

export interface DispatcherOptions {
  config?: Partial<DispatcherConfig>;
  notificationAdapter?: INotificationAdapter;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  nowProvider?: () => Date;
}

export class ResilientDispatcher {
  private readonly config: DispatcherConfig;
  private readonly adapter: INotificationAdapter;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly nowProvider: () => Date;

  // In-memory deduplication registry: key -> timestamp
  private readonly deduplicationStore = new Map<string, number>();

  constructor(options: DispatcherOptions = {}) {
    this.config = {
      maxRetries: options.config?.maxRetries ?? 3,
      baseBackoffMs: options.config?.baseBackoffMs ?? 50,
      maxBackoffMs: options.config?.maxBackoffMs ?? 500,
      maxJitterMs: options.config?.maxJitterMs ?? 25,
      dedupWindowMs: options.config?.dedupWindowMs ?? 60000,
      restrictedZones: options.config?.restrictedZones ?? [],
    };
    this.adapter = options.notificationAdapter ?? new MockNotificationAdapter();
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomFn = options.randomFn ?? (() => Math.random());
    this.nowProvider = options.nowProvider ?? (() => new Date());
  }

  /**
   * Calculates exponential backoff with full random jitter
   */
  calculateBackoff(attempt: number): number {
    const exponential = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * Math.pow(2, attempt)
    );
    const jitter = Math.floor(this.randomFn() * this.config.maxJitterMs);
    return exponential + jitter;
  }

  /**
   * Generates deduplication key based on device_id and incident_type
   */
  private getDedupKey(incident: FleetIncident): string {
    return `${incident.device_id}:${incident.type}`;
  }

  /**
   * Dispatches a single incident with retry, exponential backoff, jitter, and deduplication
   */
  async dispatch(incident: FleetIncident): Promise<ReconciliationRecord> {
    const now = this.nowProvider().getTime();
    const dedupKey = this.getDedupKey(incident);
    const lastDispatched = this.deduplicationStore.get(dedupKey);

    // 1. Deduplication check
    if (lastDispatched && now - lastDispatched < this.config.dedupWindowMs) {
      return {
        incident_id: incident.incident_id,
        device_id: incident.device_id,
        plate: incident.plate,
        model: incident.model,
        type: incident.type,
        severity: incident.severity,
        reasons: incident.reasons,
        detected_at: incident.detected_at,
        dispatch_status: 'SUPPRESSED_DUPLICATE',
        attempts_taken: 0,
      };
    }

    let attempt = 0;
    let lastError: string | undefined;

    // 2. Retry loop
    while (attempt <= this.config.maxRetries) {
      attempt++;
      try {
        const result = await this.adapter.sendAlert(incident);
        if (result.success) {
          // Success: update deduplication registry
          this.deduplicationStore.set(dedupKey, this.nowProvider().getTime());
          return {
            incident_id: incident.incident_id,
            device_id: incident.device_id,
            plate: incident.plate,
            model: incident.model,
            type: incident.type,
            severity: incident.severity,
            reasons: incident.reasons,
            detected_at: incident.detected_at,
            dispatch_status: 'DISPATCHED',
            attempts_taken: attempt,
            dispatched_at: this.nowProvider().toISOString(),
          };
        }
        lastError = result.error ?? 'Unknown error';
      } catch (err: unknown) {
        if (err instanceof DispatchError) {
          lastError = err.message;
          if (!err.isRetryable) {
            return {
              incident_id: incident.incident_id,
              device_id: incident.device_id,
              plate: incident.plate,
              model: incident.model,
              type: incident.type,
              severity: incident.severity,
              reasons: incident.reasons,
              detected_at: incident.detected_at,
              dispatch_status: 'NON_RETRYABLE_FAILURE',
              attempts_taken: attempt,
              last_error: err.message,
            };
          }
        } else {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // If attempts exhausted, break loop
      if (attempt > this.config.maxRetries) {
        break;
      }

      // Calculate backoff delay with random jitter and wait
      const backoffMs = this.calculateBackoff(attempt - 1);
      await this.sleepFn(backoffMs);
    }

    // Retries exhausted
    return {
      incident_id: incident.incident_id,
      device_id: incident.device_id,
      plate: incident.plate,
      model: incident.model,
      type: incident.type,
      severity: incident.severity,
      reasons: incident.reasons,
      detected_at: incident.detected_at,
      dispatch_status: 'RETRY_EXHAUSTED',
      attempts_taken: attempt,
      last_error: lastError,
    };
  }

  /**
   * Dispatches a batch of incidents and returns reconciliation records
   */
  async dispatchBatch(incidents: FleetIncident[]): Promise<ReconciliationRecord[]> {
    const records: ReconciliationRecord[] = [];
    for (const inc of incidents) {
      const rec = await this.dispatch(inc);
      records.push(rec);
    }
    return records;
  }

  /**
   * Exports reconciliation records to output/incident_reconciliation.json
   */
  async exportReconciliation(
    records: ReconciliationRecord[],
    outputPath: string = path.resolve(process.cwd(), 'output', 'incident_reconciliation.json')
  ): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(records, null, 2), 'utf-8');
  }

  resetDeduplication(): void {
    this.deduplicationStore.clear();
  }
}
