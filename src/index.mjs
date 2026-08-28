#!/usr/bin/env node
import { writeSync } from "node:fs";
import { readPayload, isSpawn, describeSpawn } from "./payload.mjs";
import { loadPolicy } from "./config.mjs";
import { evaluate } from "./policy.mjs";
import { resolveEffectiveModel } from "./effective-model.mjs";
import { buildDecision, outcomeOf } from "./decision.mjs";
import { record, buildEntry } from "./log.mjs";

// writeSync, not process.stdout.write: stdout is a pipe here, async writes can
// be truncated when the process exits, and a truncated decision is worse than
// no decision at all.
function emit(decision) {
  writeSync(1, JSON.stringify(decision));
}

export function run(env = process.env) {
  let payload;
  try {
    payload = readPayload(0);
  } catch {
    return null; // Unparseable stdin: stay silent, let the spawn through.
  }

  if (!isSpawn(payload)) return null;

  const spawn = describeSpawn(payload);
  const { policy, source, error } = loadPolicy(env);
  const effective = resolveEffectiveModel(spawn, env);
  const verdict = evaluate(policy, spawn);
  const decision = buildDecision(verdict, spawn, effective);
  const outcome = outcomeOf(verdict, decision, effective);

  record(
    {
      ...buildEntry({
        spawn,
        effective,
        verdict,
        outcome,
        forcedModel: decision?.hookSpecificOutput?.updatedInput?.model ?? null,
        policySource: source,
      }),
      ...(error ? { policy_error: error } : {}),
    },
    env,
  );

  return decision;
}

// Every failure path is silent and non-blocking. A hook that can break a
// session is a hook nobody installs.
try {
  const decision = run();
  if (decision) emit(decision);
} catch {
  // Deliberately empty: fail open.
}
