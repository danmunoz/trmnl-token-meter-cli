import { CodexCounterLedger } from "./codex-counter.js";
import type { UsageEvent } from "./types.js";
import { warning } from "./warnings.js";

export interface ForkLedgerResult {
  events: UsageEvent[];
  ambiguousForkCount: number;
}

function keyFor(event: UsageEvent): string {
  return [event.session_id, event.branch_id ?? "main"].join(":");
}

export function applyForkLedger(events: UsageEvent[]): ForkLedgerResult {
  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ledger = new CodexCounterLedger();
  const output: UsageEvent[] = [];
  let ambiguousForkCount = 0;

  for (const event of sorted) {
    if (event.branch_id && !event.parent_id) ambiguousForkCount += 1;
    const adjusted = ledger.apply(event, keyFor(event));
    if (adjusted) output.push(adjusted);
  }

  return { events: output, ambiguousForkCount };
}

export function forkWarnings(count: number) {
  return count > 0 ? [warning("malformed_records_skipped", count)] : [];
}
