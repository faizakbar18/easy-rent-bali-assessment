/**
 * Easy Rent Bali - Reliability Toolkit
 * Fleet Triage Engine & Resilient Dispatcher Automated Verification Suite
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VehicleTelemetry } from '../src/engine/types.js';
import { FleetTriageEngine } from '../src/engine/triage_engine.js';
import {
  ResilientDispatcher,
  MockNotificationAdapter,
} from '../src/engine/dispatcher.js';

describe('Fleet Self-Healing Engine (8-Vehicle Starter Dataset)', () => {
  let telemetryData: VehicleTelemetry[];
  let triageEngine: FleetTriageEngine;

  beforeEach(async () => {
    const rawData = await fs.readFile(
      path.resolve(process.cwd(), 'data', 'outage_telemetry.json'),
      'utf-8'
    );
    telemetryData = JSON.parse(rawData);
    triageEngine = new FleetTriageEngine();
  });

  it('correctly processes all 8 starter vehicles according to exact assessment rules', () => {
    const incidents = triageEngine.processBatch(telemetryData);

    // Map by device_id
    const incidentMap = new Map<string, typeof incidents>();
    for (const inc of incidents) {
      const list = incidentMap.get(inc.device_id) ?? [];
      list.push(inc);
      incidentMap.set(inc.device_id, list);
    }

    // 1. iot_car_01: Rented, moving 45 km/h in CANGGU (normal zone) -> NO INCIDENT
    expect(incidentMap.get('iot_car_01')).toBeUndefined();

    // 2. iot_car_02: Available, moving 52 km/h in KUTA_HUB -> CRITICAL_SECURITY_ALERT
    const car02Incidents = incidentMap.get('iot_car_02');
    expect(car02Incidents).toHaveLength(1);
    expect(car02Incidents![0].type).toBe('CRITICAL_SECURITY_ALERT');
    expect(car02Incidents![0].severity).toBe('CRITICAL');
    expect(car02Incidents![0].reasons[0]).toContain("status is 'available' but current speed is 52 km/h");

    // 3. iot_car_03: Rented, battery 11.2V < 11.5V -> MAINTENANCE_REQUIRED
    const car03Incidents = incidentMap.get('iot_car_03');
    expect(car03Incidents).toHaveLength(1);
    expect(car03Incidents![0].type).toBe('MAINTENANCE_REQUIRED');
    expect(car03Incidents![0].severity).toBe('MEDIUM');
    expect(car03Incidents![0].reasons[0]).toContain('Battery voltage 11.2V is below threshold 11.5V');

    // 4. iot_car_04: Rented, fuel 9% < 15% -> MAINTENANCE_REQUIRED
    const car04Incidents = incidentMap.get('iot_car_04');
    expect(car04Incidents).toHaveLength(1);
    expect(car04Incidents![0].type).toBe('MAINTENANCE_REQUIRED');
    expect(car04Incidents![0].reasons[0]).toContain('Fuel level 9% is below threshold 15%');

    // 5. iot_car_05: Rented, speed 60, zone RESTRICTED_OFFROAD_BATUKARU -> CRITICAL_SECURITY_ALERT
    const car05Incidents = incidentMap.get('iot_car_05');
    expect(car05Incidents).toHaveLength(1);
    expect(car05Incidents![0].type).toBe('CRITICAL_SECURITY_ALERT');
    expect(car05Incidents![0].reasons[0]).toContain("Geofence violation: vehicle detected in restricted zone 'RESTRICTED_OFFROAD_BATUKARU'");

    // 6. iot_car_06: Rented, last ping 1320s > 900s -> OFFLINE_TELEMETRY_DROP
    const car06Incidents = incidentMap.get('iot_car_06');
    expect(car06Incidents).toHaveLength(1);
    expect(car06Incidents![0].type).toBe('OFFLINE_TELEMETRY_DROP');
    expect(car06Incidents![0].severity).toBe('HIGH');
    expect(car06Incidents![0].reasons[0]).toContain('Active rented vehicle silent for 1320s');

    // 7. iot_car_07: Available, speed 0 km/h in KUTA_HUB, healthy -> NO INCIDENT
    expect(incidentMap.get('iot_car_07')).toBeUndefined();

    // 8. iot_car_08: Available, battery 11.3V AND fuel 11% -> MAINTENANCE_REQUIRED with BOTH REASONS PRESERVED
    const car08Incidents = incidentMap.get('iot_car_08');
    expect(car08Incidents).toHaveLength(1);
    expect(car08Incidents![0].type).toBe('MAINTENANCE_REQUIRED');
    expect(car08Incidents![0].reasons).toHaveLength(2);
    expect(car08Incidents![0].reasons[0]).toContain('Battery voltage 11.3V is below threshold 11.5V');
    expect(car08Incidents![0].reasons[1]).toContain('Fuel level 11% is below threshold 15%');

    // Total actionable incidents: 6 incidents across 6 affected vehicles (out of 8)
    expect(incidents).toHaveLength(6);
  });
});

describe('Resilient Alert Dispatcher', () => {
  let adapter: MockNotificationAdapter;
  let dispatcher: ResilientDispatcher;

  beforeEach(() => {
    adapter = new MockNotificationAdapter();
    dispatcher = new ResilientDispatcher({
      notificationAdapter: adapter,
      config: {
        maxRetries: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 50,
        maxJitterMs: 10,
        dedupWindowMs: 5000,
      },
    });
  });

  it('dispatches immediately on first attempt when no errors occur', async () => {
    const incident = {
      incident_id: 'inc_test_01',
      device_id: 'iot_car_02',
      plate: 'DK 5678 CD',
      model: 'Mitsubishi Xpander',
      type: 'CRITICAL_SECURITY_ALERT' as const,
      severity: 'CRITICAL' as const,
      reasons: ['Unauthorized vehicle movement'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    const record = await dispatcher.dispatch(incident);

    expect(record.dispatch_status).toBe('DISPATCHED');
    expect(record.attempts_taken).toBe(1);
    expect(adapter.getAttempts('inc_test_01')).toBe(1);
  });

  it('retries with exponential backoff on transient failure and recovers', async () => {
    const incident = {
      incident_id: 'inc_test_02',
      device_id: 'iot_car_03',
      plate: 'DK 9012 EF',
      model: 'Toyota Innova Zenix',
      type: 'MAINTENANCE_REQUIRED' as const,
      severity: 'MEDIUM' as const,
      reasons: ['Battery low'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    // Plan failure on attempt 1 and 2, succeed on attempt 3
    adapter.planFailure('inc_test_02', 2, true);

    const record = await dispatcher.dispatch(incident);

    expect(record.dispatch_status).toBe('DISPATCHED');
    expect(record.attempts_taken).toBe(3);
    expect(adapter.getAttempts('inc_test_02')).toBe(3);
  });

  it('marks RETRY_EXHAUSTED when failure exceeds max retry limit', async () => {
    const incident = {
      incident_id: 'inc_test_03',
      device_id: 'iot_car_04',
      plate: 'DK 3456 GH',
      model: 'Suzuki Ertiga',
      type: 'MAINTENANCE_REQUIRED' as const,
      severity: 'MEDIUM' as const,
      reasons: ['Fuel low'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    // Plan failure on attempts 1 to 5 (exceeds maxRetries 3 + 1 initial = 4 total)
    adapter.planFailure('inc_test_03', 5, true);

    const record = await dispatcher.dispatch(incident);

    expect(record.dispatch_status).toBe('RETRY_EXHAUSTED');
    expect(record.attempts_taken).toBe(4); // 1 initial + 3 retries
    expect(record.last_error).toBeDefined();
  });

  it('fails fast on non-retryable error without executing retries', async () => {
    const incident = {
      incident_id: 'inc_test_04',
      device_id: 'iot_car_05',
      plate: 'DK 7890 IJ',
      model: 'Toyota Fortuner',
      type: 'CRITICAL_SECURITY_ALERT' as const,
      severity: 'CRITICAL' as const,
      reasons: ['Offroad'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    // Non-retryable error (e.g. HTTP 400 Bad Request)
    adapter.planFailure('inc_test_04', 1, false);

    const record = await dispatcher.dispatch(incident);

    expect(record.dispatch_status).toBe('NON_RETRYABLE_FAILURE');
    expect(record.attempts_taken).toBe(1); // No retries performed!
    expect(adapter.getAttempts('inc_test_04')).toBe(1);
  });

  it('suppresses duplicate incidents within deduplication window', async () => {
    const incidentA = {
      incident_id: 'inc_test_dup_1',
      device_id: 'iot_car_06',
      plate: 'DK 2345 KL',
      model: 'Toyota Raize',
      type: 'OFFLINE_TELEMETRY_DROP' as const,
      severity: 'HIGH' as const,
      reasons: ['Silent > 15m'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    const incidentB = {
      incident_id: 'inc_test_dup_2',
      device_id: 'iot_car_06', // Same device
      plate: 'DK 2345 KL',
      model: 'Toyota Raize',
      type: 'OFFLINE_TELEMETRY_DROP' as const, // Same type
      severity: 'HIGH' as const,
      reasons: ['Silent > 15m'],
      detected_at: new Date().toISOString(),
      telemetry_snapshot: {} as any,
    };

    const record1 = await dispatcher.dispatch(incidentA);
    expect(record1.dispatch_status).toBe('DISPATCHED');

    // Dispatched within dedupWindowMs (5000ms)
    const record2 = await dispatcher.dispatch(incidentB);
    expect(record2.dispatch_status).toBe('SUPPRESSED_DUPLICATE');
    expect(record2.attempts_taken).toBe(0);
  });
});
