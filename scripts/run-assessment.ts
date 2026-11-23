/**
 * Easy Rent Bali - Reliability Toolkit
 * Main End-to-End Assessment Execution Runner
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VehicleTelemetry } from '../src/engine/types.js';
import { FleetTriageEngine } from '../src/engine/triage_engine.js';
import { ResilientDispatcher } from '../src/engine/dispatcher.js';

async function main() {
  console.log('======================================================================');
  console.log('   EASY RENT BALI - RELIABILITY TOOLKIT & FLEET TRIAGE ENGINE        ');
  console.log('   Track Option C: Infrastructure, Concurrency & Fleet Reliability    ');
  console.log('======================================================================\n');

  const telemetryPath = path.resolve(process.cwd(), 'data', 'outage_telemetry.json');
  const outputPath = path.resolve(process.cwd(), 'output', 'incident_reconciliation.json');

  console.log(`[1/4] Ingesting starter fleet dataset: ${telemetryPath}`);
  const rawData = await fs.readFile(telemetryPath, 'utf-8');
  const telemetryData: VehicleTelemetry[] = JSON.parse(rawData);
  console.log(`      Ingested ${telemetryData.length} vehicle telemetry records successfully.\n`);

  console.log('[2/4] Running Fleet Triage Engine against operational & security rules...');
  const triageEngine = new FleetTriageEngine();
  const incidents = triageEngine.processBatch(telemetryData);
  console.log(`      Detected ${incidents.length} actionable fleet incidents.\n`);

  console.log('[3/4] Dispatching alerts through resilient dispatcher (retry + backoff + jitter)...');
  const dispatcher = new ResilientDispatcher({
    config: {
      baseBackoffMs: 20,
      maxBackoffMs: 100,
      maxJitterMs: 15,
      maxRetries: 3,
    },
  });

  const reconciliationRecords = await dispatcher.dispatchBatch(incidents);
  console.log(`      Dispatched ${reconciliationRecords.length} alert notifications.\n`);

  console.log(`[4/4] Writing incident reconciliation ledger: ${outputPath}`);
  await dispatcher.exportReconciliation(reconciliationRecords, outputPath);
  console.log('      Reconciliation ledger exported successfully.\n');

  // Summary Table
  console.log('----------------------------------------------------------------------------------------------------------------');
  console.log('| Device ID  | Plate No.   | Incident Type            | Severity | Dispatch Status | Attempts | Reasons Count  |');
  console.log('----------------------------------------------------------------------------------------------------------------');
  for (const rec of reconciliationRecords) {
    const dev = rec.device_id.padEnd(10);
    const plt = rec.plate.padEnd(11);
    const typ = rec.type.padEnd(24);
    const sev = rec.severity.padEnd(8);
    const sta = rec.dispatch_status.padEnd(15);
    const att = String(rec.attempts_taken).padStart(8);
    const rsc = String(rec.reasons.length).padStart(14);
    console.log(`| ${dev} | ${plt} | ${typ} | ${sev} | ${sta} | ${att} | ${rsc} |`);
  }
  console.log('----------------------------------------------------------------------------------------------------------------\n');

  console.log('All assessment deliverables validated and ready.');
}

main().catch((err) => {
  console.error('Fatal assessment execution error:', err);
  process.exit(1);
});
