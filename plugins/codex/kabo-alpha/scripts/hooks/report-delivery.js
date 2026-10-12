#!/usr/bin/env node
// Native Stop completion check for opt-in signed reports; never executes business code.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataRoot, workRoot } from '../lib/common.js';
import { completedReportsForScope } from '../lib/host-attempt.js';
const normalize = value => value.replace(/\r\n/g, '\n').trim();
export function checkReportDelivery(event, options = {}) {
  if (event?.hook_event_name !== 'Stop' || typeof event.session_id !== 'string' || typeof event.turn_id !== 'string') return {};
  let reports;
  try { reports = completedReportsForScope({ hostScope: { session_id: event.session_id, turn_id: event.turn_id },
    root: options.root ?? dataRoot(), workRoot: options.workRoot ?? workRoot() }); }
  catch {
    return event.stop_hook_active === true
      ? { continue: false, stopReason: 'The validated report could not be delivered. This attempt remains incomplete.' }
      : { decision: 'block', reason: 'The completed signed report failed its final artifact check. Preserve the attempt and report the delivery failure; do not rerun scripts, replace the run or claim completion.' };
  }
  const reply = typeof event.last_assistant_message === 'string' ? normalize(event.last_assistant_message) : '';
  const missing = reports.filter(report => !reply.includes(normalize(report.text)));
  if (missing.length === 0) return {};
  if (event.stop_hook_active === true) return { continue: false,
    stopReason: 'The validated report was not delivered in full. This attempt remains incomplete.' };
  return { decision: 'block', reason: `A completed signed report has not been delivered in full. Call kabo_runtime.read_report for these run IDs: ${missing.map(report => report.run_id).join(', ')}. Relay their complete creator bodies, preserving their structure and facts. Do not re-execute scripts or reserve replacements.` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output;
  try { output = checkReportDelivery(JSON.parse(fs.readFileSync(0, 'utf8'))); }
  catch { output = {}; } // Unrecognised host input is not a signed-contract completion event.
  process.stdout.write(JSON.stringify(output) + '\n');
}
