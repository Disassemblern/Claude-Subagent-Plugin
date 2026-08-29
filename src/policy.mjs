export const BUILT_IN_POLICY = Object.freeze({
  fallback: "allow",
  rules: Object.freeze([]),
});

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// JavaScript has no inline flag groups, but "(?i)foo" is what people write in
// a config file. Translate a leading group into real RegExp flags so that a
// case-insensitive rule does what it looks like it does.
const INLINE_FLAGS = /^\(\?([imsu]+)\)/;

export function compileRegex(pattern) {
  const inline = INLINE_FLAGS.exec(pattern);
  return inline
    ? new RegExp(pattern.slice(inline[0].length), inline[1])
    : new RegExp(pattern);
}

function testRegex(pattern, value) {
  try {
    return compileRegex(pattern).test(value ?? "");
  } catch {
    return false; // A malformed rule must never match, and never throw.
  }
}

// Every predicate present on `match` must hold. An empty match object never
// matches, so a typo cannot silently become a catch-all.
function matches(match, spawn) {
  if (!match || typeof match !== "object") return false;
  const checks = [];

  if (match.always === true) checks.push(true);
  if (match.subagent_type !== undefined) {
    checks.push(asArray(match.subagent_type).includes(spawn.subagentType));
  }
  if (match.descriptionRegex !== undefined) {
    checks.push(testRegex(match.descriptionRegex, spawn.description));
  }
  if (match.promptRegex !== undefined) {
    checks.push(testRegex(match.promptRegex, spawn.prompt));
  }
  if (match.promptLengthUnder !== undefined) {
    checks.push(spawn.prompt.length < Number(match.promptLengthUnder));
  }
  if (match.promptLengthOver !== undefined) {
    checks.push(spawn.prompt.length > Number(match.promptLengthOver));
  }
  if (match.background !== undefined) {
    checks.push(spawn.background === Boolean(match.background));
  }

  return checks.length > 0 && checks.every(Boolean);
}

export const ACTIONS = Object.freeze(["allow", "force-model", "prompt", "deny"]);

// First matching rule wins.
export function evaluate(policy, spawn) {
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  const index = rules.findIndex((rule) => matches(rule?.match, spawn));

  if (index >= 0) {
    const rule = rules[index];
    const action = ACTIONS.includes(rule?.action) ? rule.action : "allow";
    return Object.freeze({
      action,
      model: rule?.model ?? null,
      reason: rule?.reason ?? null,
      ruleIndex: index,
      ruleName: rule?.name ?? null,
    });
  }

  const fallback = ACTIONS.includes(policy?.fallback) ? policy.fallback : "allow";
  return Object.freeze({
    action: fallback,
    model: policy?.fallbackModel ?? null,
    reason: null,
    ruleIndex: -1,
    ruleName: "fallback",
  });
}

const REGEX_FIELDS = Object.freeze(["descriptionRegex", "promptRegex"]);

// Bad rules fail silently by design at spawn time, which is exactly when you
// would not notice them. This surfaces them at install and check time instead.
export function validatePolicy(policy) {
  const problems = [];
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];

  if (policy?.fallback !== undefined && !ACTIONS.includes(policy.fallback)) {
    problems.push(`fallback: unknown action "${policy.fallback}"`);
  }

  rules.forEach((rule, i) => {
    const label = rule?.name ? `rule "${rule.name}"` : `rule #${i}`;
    if (!rule?.match || typeof rule.match !== "object" || Object.keys(rule.match).length === 0) {
      problems.push(`${label}: empty or missing match, it will never fire`);
    }
    if (rule?.action !== undefined && !ACTIONS.includes(rule.action)) {
      problems.push(`${label}: unknown action "${rule.action}"`);
    }
    if (rule?.action === "force-model" && !rule?.model) {
      problems.push(`${label}: force-model needs a "model"`);
    }
    for (const field of REGEX_FIELDS) {
      if (rule?.match?.[field] === undefined) continue;
      try {
        compileRegex(rule.match[field]);
      } catch (err) {
        problems.push(`${label}: ${field} is not a valid pattern (${err.message})`);
      }
    }
  });

  return problems;
}

// The hook's own timeout in hooks.json is 300s; if the gate waits longer than
// that, Claude Code kills the hook mid-dialog. Clamp below it so a generous
// promptTimeoutMs can never outlive the process that is waiting on it.
const HOOK_TIMEOUT_CEILING_MS = 280_000;

const clamp = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : undefined;

export function brokerOptions(policy) {
  const candidates = {
    timeoutMs: clamp(policy?.promptTimeoutMs, 5_000, HOOK_TIMEOUT_CEILING_MS),
    minCoalesceMs: clamp(policy?.coalesceMs, 0, 15_000),
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, v]) => v !== undefined));
}
