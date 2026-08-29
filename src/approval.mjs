import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateHome, ensureDir } from "./config.mjs";

// The hook learns about spawn N only when it happens, so it can never tell you
// up front how many are coming. The model can: it knows its own fan-out before
// it issues a single call. So the model declares the plan, the user approves it
// in the terminal, and this file is the contract the hook enforces.
export const planPath = (env = process.env) =>
  env.SUBAGENT_GATE_PLAN || join(gateHome(env), "approved-plan.json");

export const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

const normalise = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function readPlan(env = process.env) {
  const file = planPath(env);
  if (!existsSync(file)) return null;
  try {
    const plan = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(plan?.agents) ? plan : null;
  } catch {
    return null;
  }
}

export function writePlan(plan, env = process.env) {
  const file = planPath(env);
  try {
    ensureDir(file);
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// A plan is only good for the turn it was approved for. Without an expiry, one
// approval would silently authorise every future spawn in the session.
export function planIsFresh(plan, { now, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const at = Date.parse(plan?.approvedAt ?? "");
  if (!Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}

// Descriptions are model-authored on both sides - it writes the plan and then
// writes the tool call - so they usually match exactly. Fall back to containment
// before giving up, since it may reword slightly between the two.
export function findEntry(plan, description) {
  const agents = Array.isArray(plan?.agents) ? plan.agents : [];
  const want = normalise(description);
  if (!want) return null;

  const exact = agents.find((a) => normalise(a.description) === want);
  if (exact) return exact;

  return (
    agents.find((a) => {
      const got = normalise(a.description);
      return got && (got.includes(want) || want.includes(got));
    }) ?? null
  );
}

export const PROTOCOL = [
  "SUBAGENT APPROVAL REQUIRED - this spawn was blocked because the user has not seen the plan yet.",
  "",
  "Do this before spawning any subagent:",
  "1. Work out the FULL set of subagents you intend to spawn this turn.",
  "2. Use AskUserQuestion with ONE QUESTION PER AGENT so the user sets each model individually.",
  "   A single call takes up to 4 questions, so up to four agents are one call; beyond that,",
  "   several calls of four. Do NOT offer bundled presets like 'all haiku' or 'mixed' - that",
  "   takes the per-agent choice away, which is the whole point of asking.",
  "   Each question names the agent, says what it will do and roughly how big the task is.",
  "   Each offers up to 4 model options, cheapest first, usually haiku / sonnet / opus / skip.",
  "3. Write the approved plan to this exact path:",
  "     {PLAN_PATH}",
  '   as JSON: {"approvedAt":"<current ISO 8601 UTC timestamp>","cwd":"{CWD}","agents":[',
  '     {"description":"<exactly the description you will pass to the Agent tool>",',
  '      "model":"haiku|sonnet|opus|fable|inherit|skip"}]}',
  '   Use "skip" for an agent the user does not want spawned at all.',
  "4. Then issue the Agent calls, using exactly those descriptions.",
  "",
  "Do not skip step 2. The user asked to see every subagent before any of them runs.",
].join("\n");

export function protocolMessage(env = process.env, cwd = "") {
  return PROTOCOL.replace("{PLAN_PATH}", planPath(env)).replace("{CWD}", cwd || "<cwd>");
}

// Returns what the hook should do with this spawn given the approved plan.
export function consult(spawn, { env = process.env, now, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const plan = readPlan(env);
  if (!plan) {
    return { outcome: "no-plan", reason: protocolMessage(env, spawn.cwd) };
  }
  if (!planIsFresh(plan, { now, maxAgeMs })) {
    return {
      outcome: "stale-plan",
      reason: `The approved subagent plan has expired.\n\n${protocolMessage(env, spawn.cwd)}`,
    };
  }
  if (plan.cwd && spawn.cwd && normalise(plan.cwd) !== normalise(spawn.cwd)) {
    return {
      outcome: "wrong-cwd",
      reason: `The approved plan was for a different directory.\n\n${protocolMessage(env, spawn.cwd)}`,
    };
  }

  const entry = findEntry(plan, spawn.description);
  if (!entry) {
    const known = (plan.agents ?? []).map((a) => `  - ${a.description}`).join("\n");
    return {
      outcome: "not-in-plan",
      reason:
        `"${spawn.description}" was not in the plan the user approved. Approved agents were:\n${known}\n\n` +
        "Either use one of those descriptions exactly, or get a new plan approved.",
    };
  }
  if (normalise(entry.model) === "skip") {
    return { outcome: "skipped", reason: `The user chose not to run "${spawn.description}".` };
  }

  const model = normalise(entry.model) === "inherit" ? null : entry.model;
  return { outcome: "approved", model: model ?? null };
}
