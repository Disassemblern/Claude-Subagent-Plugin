#!/usr/bin/env node
import { writeSync } from "node:fs";
import { readPayload, isSpawn, describeSpawn } from "./payload.mjs";
import { loadPolicy } from "./config.mjs";
import { evaluate } from "./policy.mjs";
import { resolveEffectiveModel } from "./effective-model.mjs";
import { buildDecision, outcomeOf } from "./decision.mjs";
import { record, buildEntry } from "./log.mjs";
import { decide, prune } from "./broker.mjs";
import { askUser, uiAvailable } from "./ui/index.mjs";
import { rememberRule } from "./remember.mjs";

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

// Opens one dialog for the whole fan-out and turns this spawn's answer into a
// hook decision. Falls through to the caller's static handling when no UI is
// available, which is what keeps this usable on platforms without an adapter.
async function runGate(spawn, effective, env) {
  const answer = await decide({ spawn, effective, askUser, env });

  if (answer.remember && answer.model) {
    rememberRule({ subagentType: spawn.subagentType, model: answer.model }, env);
  }

  if (!answer.approved) {
    return {
      decision: deny("Subagent gate: you declined this spawn. Do not retry it."),
      outcome: "gate-denied",
      forcedModel: null,
    };
  }
  if (answer.model && answer.model !== effective.model) {
    return {
      decision: allow({ ...spawn.input, model: answer.model }),
      outcome: "gate-remodelled",
      forcedModel: answer.model,
    };
  }
  return { decision: null, outcome: `gate-approved:${answer.via ?? "dialog"}`, forcedModel: null };
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
  const { policy, source, error } = loadPolicy(env);
  const effective = resolveEffectiveModel(spawn, env);
  const verdict = evaluate(policy, spawn);

  let decision;
  let outcome;
  let forcedModel;

  if (verdict.action === "prompt" && uiAvailable(env)) {
    prune(env);
    ({ decision, outcome, forcedModel } = await runGate(spawn, effective, env));
  } else {
    decision = buildDecision(verdict, spawn, effective);
    outcome = outcomeOf(verdict, decision, effective);
    forcedModel = decision?.hookSpecificOutput?.updatedInput?.model ?? null;
  }

  record(
    {
      ...buildEntry({ spawn, effective, verdict, outcome, forcedModel, policySource: source }),
      ...(error ? { policy_error: error } : {}),
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
