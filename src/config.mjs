import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { BUILT_IN_POLICY } from "./policy.mjs";

export function gateHome(env = process.env) {
  return env.SUBAGENT_GATE_HOME || join(homedir(), ".claude", "subagent-gate");
}

export function policyPath(env = process.env) {
  return env.SUBAGENT_GATE_POLICY || join(gateHome(env), "policy.json");
}

export function auditPath(env = process.env) {
  return env.SUBAGENT_GATE_AUDIT || join(gateHome(env), "audit.jsonl");
}

// A missing or broken policy file falls back to allow-everything. The gate must
// never be the reason a session stops working.
export function loadPolicy(env = process.env) {
  const file = policyPath(env);
  if (!existsSync(file)) return { policy: BUILT_IN_POLICY, source: "default", error: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { policy: parsed, source: file, error: null };
  } catch (err) {
    return { policy: BUILT_IN_POLICY, source: "default", error: String(err?.message ?? err) };
  }
}

export function ensureDir(filePath) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
