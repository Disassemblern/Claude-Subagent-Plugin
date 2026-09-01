#!/usr/bin/env node
import { writeSync } from "node:fs";
import { readPayload, isSpawn, describeSpawn } from "./payload.mjs";
import { loadPolicy } from "./config.mjs";
import { evaluate } from "./policy.mjs";
import { resolveEffectiveModel } from "./effective-model.mjs";
import { buildDecision, outcomeOf } from "./decision.mjs";
import { record, buildEntry } from "./log.mjs";
import { consult } from "./approval.mjs";

// writeSync, not process.stdout.write: stdout is a pipe here, async writes can
// be truncated when the process exits, and a truncated decision is worse than
// no decision at all.
function emit(decision) {
  writeSync(1, JSON.stringify(decision));
}

const allow = (updatedInput) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput },
});

const deny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

// The hook learns about spawn N only as it happens, so it can never tell the
// user how many are coming. The model knows its own fan-out before it issues a
// single call, so it declares the plan, the user approves it in the terminal,
// and this enforces the answer.
function chatGate(spawn, env, policy) {
  const result = consult(spawn, {
    env,
    now: Date.now(),
    ...(typeof policy?.planMaxAgeMs === "number" ? { maxAgeMs: policy.planMaxAgeMs } : {}),
  });

  if (result.outcome === "approved") {
    return result.model
      ? {
          decision: allow({ ...spawn.input, model: result.model }),
          outcome: "plan-remodelled",
          forcedModel: result.model,
        }
      : { decision: null, outcome: "plan-approved", forcedModel: null };
  }
  return { decision: deny(result.reason), outcome: `plan-${result.outcome}`, forcedModel: null };
}

export async function run(env = process.env) {
  let payload;
  try {
    payload = readPayload(0);
  } catch {
    return null; // Unparseable stdin: stay silent, let the spawn through.
  }

  if (!isSpawn(payload)) return null;

  const spawn = describeSpawn(payload);
  const { policy, source, error, seeded } = loadPolicy(env);
  const effective = resolveEffectiveModel(spawn, env);
  const verdict = evaluate(policy, spawn);

  let decision;
  let outcome;
  let forcedModel;

  if (verdict.action === "prompt") {
    ({ decision, outcome, forcedModel } = chatGate(spawn, env, policy));
  } else {
    decision = buildDecision(verdict, spawn, effective);
    outcome = outcomeOf(verdict, decision, effective);
    forcedModel = decision?.hookSpecificOutput?.updatedInput?.model ?? null;
  }

  record(
    {
      ...buildEntry({ spawn, effective, verdict, outcome, forcedModel, policySource: source }),
      ...(error ? { policy_error: error } : {}),
      ...(seeded ? { policy_seeded: true } : {}),
    },
    env,
  );

  return decision;
}

// Every failure path is silent and non-blocking. A hook that can break a
// session is a hook nobody installs.
try {
  const decision = await run();
  if (decision) emit(decision);
} catch {
  // Deliberately empty: fail open.
}
