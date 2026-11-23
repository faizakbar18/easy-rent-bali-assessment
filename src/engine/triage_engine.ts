/**
 * Easy Rent Bali - Fleet Reliability Toolkit
 * Real-Time Telemetry Triage Engine
 */

import {
  VehicleTelemetry,
  FleetIncident,
  IncidentType,
  IncidentSeverity,
} from './types.js';

export interface TriageEngineOptions {
  restrictedZones?: string[];
  offlineThresholdSeconds?: number;
  lowBatteryThresholdVolts?: number;
  lowFuelThresholdPercent?: number;
  nowProvider?: () => Date;
}

export const DEFAULT_RESTRICTED_ZONES = [
  'RESTRICTED_OFFROAD_BATUKARU',
  'RESTRICTED_VOLCANO_AGUNG',
  'RESTRICTED_NUSA_PENIDA_CLIFFS',
];

export class FleetTriageEngine {
  private readonly restrictedZones: Set<string>;
  private readonly offlineThresholdSeconds: number;
  private readonly lowBatteryThresholdVolts: number;
  private readonly lowFuelThresholdPercent: number;
  private readonly nowProvider: () => Date;

  constructor(options: TriageEngineOptions = {}) {
    this.restrictedZones = new Set(
      (options.restrictedZones ?? DEFAULT_RESTRICTED_ZONES).map((z) => z.toUpperCase())
    );
    this.offlineThresholdSeconds = options.offlineThresholdSeconds ?? 900; // 15 mins
    this.lowBatteryThresholdVolts = options.lowBatteryThresholdVolts ?? 11.5;
    this.lowFuelThresholdPercent = options.lowFuelThresholdPercent ?? 15;
    this.nowProvider = options.nowProvider ?? (() => new Date());
  }

  /**
   * Evaluates a single vehicle telemetry report against all operational and security rules.
   * Returns a list of zero or more incidents detected.
   */
  evaluateTelemetry(telemetry: VehicleTelemetry): FleetIncident[] {
    const incidents: FleetIncident[] = [];
    const timestampStr = this.nowProvider().toISOString();

    // -------------------------------------------------------------------------
    // Rule 1: CRITICAL_SECURITY_ALERT
    // Condition A: Available vehicle moving (> 0 km/h) - unauthorized movement/theft
    // Condition B: Vehicle is inside a restricted offroad/danger zone
    // -------------------------------------------------------------------------
    const isAvailableMoving =
      telemetry.status === 'available' && telemetry.current_speed_kmh > 0;
    const isZoneRestricted =
      telemetry.current_location?.zone &&
      this.restrictedZones.has(telemetry.current_location.zone.toUpperCase());

    if (isAvailableMoving || isZoneRestricted) {
      const securityReasons: string[] = [];
      if (isAvailableMoving) {
        securityReasons.push(
          `Unauthorized vehicle movement: status is 'available' but current speed is ${telemetry.current_speed_kmh} km/h.`
        );
      }
      if (isZoneRestricted) {
        securityReasons.push(
          `Geofence violation: vehicle detected in restricted zone '${telemetry.current_location.zone}'.`
        );
      }

      incidents.push({
        incident_id: `inc_sec_${telemetry.device_id}_${Date.now()}`,
        device_id: telemetry.device_id,
        plate: telemetry.plate,
        model: telemetry.model,
        type: 'CRITICAL_SECURITY_ALERT',
        severity: 'CRITICAL',
        reasons: securityReasons,
        detected_at: timestampStr,
        telemetry_snapshot: { ...telemetry },
      });
    }

    // -------------------------------------------------------------------------
    // Rule 2: OFFLINE_TELEMETRY_DROP
    // Condition: Active rented vehicle has been silent for > 900 seconds (15 mins)
    // -------------------------------------------------------------------------
    if (
      telemetry.status === 'rented' &&
      telemetry.last_ping_seconds_ago > this.offlineThresholdSeconds
    ) {
      incidents.push({
        incident_id: `inc_off_${telemetry.device_id}_${Date.now()}`,
        device_id: telemetry.device_id,
        plate: telemetry.plate,
        model: telemetry.model,
        type: 'OFFLINE_TELEMETRY_DROP',
        severity: 'HIGH',
        reasons: [
          `Active rented vehicle silent for ${telemetry.last_ping_seconds_ago}s (threshold: > ${this.offlineThresholdSeconds}s / 15 mins).`,
        ],
        detected_at: timestampStr,
        telemetry_snapshot: { ...telemetry },
      });
    }

    // -------------------------------------------------------------------------
    // Rule 3: MAINTENANCE_REQUIRED
    // Condition: Battery voltage < 11.5V OR Fuel percent < 15%
    // Both reasons must be preserved if both conditions trigger
    // -------------------------------------------------------------------------
    const isLowBattery = telemetry.battery_voltage < this.lowBatteryThresholdVolts;
    const isLowFuel = telemetry.fuel_percent < this.lowFuelThresholdPercent;

    if (isLowBattery || isLowFuel) {
      const maintenanceReasons: string[] = [];
      if (isLowBattery) {
        maintenanceReasons.push(
          `Battery voltage ${telemetry.battery_voltage}V is below threshold ${this.lowBatteryThresholdVolts}V.`
        );
      }
      if (isLowFuel) {
        maintenanceReasons.push(
          `Fuel level ${telemetry.fuel_percent}% is below threshold ${this.lowFuelThresholdPercent}%.`
        );
      }

      incidents.push({
        incident_id: `inc_maint_${telemetry.device_id}_${Date.now()}`,
        device_id: telemetry.device_id,
        plate: telemetry.plate,
        model: telemetry.model,
        type: 'MAINTENANCE_REQUIRED',
        severity: 'MEDIUM',
        reasons: maintenanceReasons,
        detected_at: timestampStr,
        telemetry_snapshot: { ...telemetry },
      });
    }

    return incidents;
  }

  /**
   * Processes an array of vehicle telemetry entries and returns all detected incidents.
   */
  processBatch(telemetries: VehicleTelemetry[]): FleetIncident[] {
    const allIncidents: FleetIncident[] = [];
    for (const t of telemetries) {
      const detected = this.evaluateTelemetry(t);
      allIncidents.push(...detected);
    }
    return allIncidents;
  }
}
