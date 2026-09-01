import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_POLICY } from "./policy.mjs";

const SHIPPED_POLICY = fileURLToPath(new URL("../policy.example.json", import.meta.url));

export function gateHome(env = process.env) {
  return env.SUBAGENT_GATE_HOME || join(homedir(), ".claude", "subagent-gate");
}

export function policyPath(env = process.env) {
  return env.SUBAGENT_GATE_POLICY || join(gateHome(env), "policy.json");
}

export function auditPath(env = process.env) {
  return env.SUBAGENT_GATE_AUDIT || join(gateHome(env), "audit.jsonl");
}

export function ensureDir(filePath) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// Installing the plugin used to leave no policy on disk, so the gate fell back
// to allow-everything and silently did nothing. Seed the shipped default the
// first time instead, then use it right away: no gap, and a real file the user
// can open and edit.
function seedPolicy(file, env) {
  if (env.SUBAGENT_GATE_NO_SEED === "1") return false;
  try {
    if (!existsSync(SHIPPED_POLICY)) return false;
    if (!ensureDir(file)) return false;
    copyFileSync(SHIPPED_POLICY, file);
    return true;
  } catch {
    return false; // Read-only home, odd permissions: fall back, never throw.
  }
}

// A missing or broken policy falls back to allow-everything. The gate must
// never be the reason a session stops working.
export function loadPolicy(env = process.env) {
  const file = policyPath(env);
  let seeded = false;

  if (!existsSync(file)) {
    seeded = seedPolicy(file, env);
    if (!seeded) return { policy: BUILT_IN_POLICY, source: "default", error: null, seeded: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { policy: parsed, source: file, error: null, seeded };
  } catch (err) {
    return {
      policy: BUILT_IN_POLICY,
      source: "default",
      error: String(err?.message ?? err),
      seeded,
    };
  }
}
