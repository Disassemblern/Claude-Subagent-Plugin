import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { policyPath, ensureDir } from "./config.mjs";

// "Remember for this type" writes the coarsest rule that is still predictable:
// this agent type always gets this model. Anything cleverer (regex derived from
// one description) would fire in places the user never intended.
export function rememberRule({ subagentType, model }, env = process.env) {
  if (!subagentType || !model) return { written: false, reason: "nothing to remember" };

  const file = policyPath(env);
  let policy = { fallback: "allow", rules: [] };
  if (existsSync(file)) {
    try {
      policy = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { written: false, reason: "policy file is not valid JSON" };
    }
  }

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const name = `remembered-${subagentType}`;
  const rule = { name, match: { subagent_type: subagentType }, action: "force-model", model };

  // Replace an existing remembered rule for the same type rather than stacking
  // duplicates that shadow each other.
  const next = rules.some((r) => r?.name === name)
    ? rules.map((r) => (r?.name === name ? rule : r))
    : [rule, ...rules];

  try {
    ensureDir(file);
    writeFileSync(file, `${JSON.stringify({ ...policy, rules: next }, null, 2)}\n`);
    return { written: true, rule: name };
  } catch (err) {
    return { written: false, reason: String(err?.message ?? err) };
  }
}
