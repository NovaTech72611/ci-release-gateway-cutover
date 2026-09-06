/**
 * One build event in, one triage decision out.
 *   npm run diagnose -- fixtures/failed_build.json
 */
import { readFileSync } from "node:fs";
import { BuildEvent, triage } from "./build_events.ts";
import { diagnose } from "./failure_diagnosis.ts";

const path = process.argv[2] ?? "fixtures/failed_build.json";
const event = BuildEvent.parse(JSON.parse(readFileSync(path, "utf8")));
const decision = triage(event);

console.log(`${event.build_id}: ${decision.action} (${decision.reason})`);

if (decision.action === "diagnose") {
  const d = await diagnose(event);
  console.log(`log tokens: ${d.log_tokens}`);
  console.log(`served by:  ${d.vendor}  cost(usd): ${d.cost_usd}`);
  console.log(d.summary);
}
