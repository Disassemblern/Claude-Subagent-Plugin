import { appendFileSync } from "node:fs";
import { auditPath, ensureDir } from "./config.mjs";

// Audit records are written by the hook itself, never scraped from transcripts:
// interactive sessions buffer subagent transcripts until a clean exit, so a
// killed session leaves nothing behind to read.
export function record(entry, env = process.env) {
  if (env.SUBAGENT_GATE_NO_AUDIT === "1") return false;
  const file = auditPath(env);
  try {
    ensureDir(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false; // Never let logging break a spawn.
  }
}

export function buildEntry({ spawn, effective, verdict, outcome, forcedModel, policySource }) {
  return {
    ts: new Date().toISOString(),
    session_id: spawn.sessionId,
    prompt_id: spawn.promptId,
    tool_use_id: spawn.toolUseId,
    subagent_type: spawn.subagentType,
    description: spawn.description,
    prompt_length: spawn.prompt.length,
    requested_model: spawn.requestedModel,
    effective_model: effective.model,
    effective_source: effective.source,
    action: verdict.action,
    outcome,
    forced_model: forcedModel ?? null,
    rule_index: verdict.ruleIndex,
    rule_name: verdict.ruleName,
    policy_source: policySource,
  };
}
