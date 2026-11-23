/**
 * Easy Rent Bali - Fleet Reliability Toolkit
 * Telemetry & Incident Domain Models
 */

export type VehicleOperationalStatus = 'available' | 'rented' | 'maintenance';

export interface VehicleLocation {
  zone: string;
  latitude?: number;
  longitude?: number;
}

export interface VehicleTelemetry {
  device_id: string;
  plate: string;
  model: string;
  status: VehicleOperationalStatus;
  current_speed_kmh: number;
  current_location: VehicleLocation;
  battery_voltage: number;
  fuel_percent: number;
  last_ping_seconds_ago: number;
  gateway_id: string;
}

export type IncidentType =
  | 'CRITICAL_SECURITY_ALERT'
  | 'OFFLINE_TELEMETRY_DROP'
  | 'MAINTENANCE_REQUIRED';

export type IncidentSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface FleetIncident {
  incident_id: string;
  device_id: string;
  plate: string;
  model: string;
  type: IncidentType;
  severity: IncidentSeverity;
  reasons: string[];
  detected_at: string;
  telemetry_snapshot: VehicleTelemetry;
}

export type DispatchStatus =
  | 'DISPATCHED'
  | 'RETRY_EXHAUSTED'
  | 'NON_RETRYABLE_FAILURE'
  | 'SUPPRESSED_DUPLICATE';

export interface ReconciliationRecord {
  incident_id: string;
  device_id: string;
  plate: string;
  model: string;
  type: IncidentType;
  severity: IncidentSeverity;
  reasons: string[];
  detected_at: string;
  dispatch_status: DispatchStatus;
  attempts_taken: number;
  last_error?: string;
  dispatched_at?: string;
}

export interface DispatcherConfig {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxJitterMs: number;
  dedupWindowMs: number;
  restrictedZones: string[];
}
