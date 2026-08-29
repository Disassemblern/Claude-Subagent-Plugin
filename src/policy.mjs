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
// matches, so a typo cannot silently become a catch-all. Use `anyOf` for OR.
function matches(match, spawn) {
  if (!match || typeof match !== "object") return false;
  const checks = [];

  if (match.always === true) checks.push(true);
  if (Array.isArray(match.anyOf)) {
    checks.push(match.anyOf.some((sub) => matches(sub, spawn)));
  }
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

export const ACTIONS = Object.freeze(["allow", "force-model", "prompt", "ask", "deny"]);

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

// "\b" in a JSON string is a BACKSPACE, not a word boundary. Written by hand it
// looks right, matches nothing, and reports no error. Same for \f. This is the
// single easiest way to write a policy that silently does nothing.
const BACKSPACE = String.fromCharCode(8);
const FORM_FEED = String.fromCharCode(12);

const JSON_ESCAPE_TRAPS = Object.freeze([
  [BACKSPACE, String.raw`\b`, String.raw`\\b`, "a literal backspace"],
  [FORM_FEED, String.raw`\f`, String.raw`\\f`, "a literal form feed"],
]);

function escapeTrap(pattern) {
  if (typeof pattern !== "string") return null;
  for (const [char, typed, fix, human] of JSON_ESCAPE_TRAPS) {
    if (!pattern.includes(char)) continue;
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    return `contains ${human} (0x${hex}). You wrote "${typed}" in JSON, which is an ` +
      `escape character rather than a regex. Write "${fix}" instead.`;
  }
  return null;
}

// An unknown predicate is ignored by matches(), so a typo like "promptLenghtUnder"
// turns a rule into one that can never fire, with no error anywhere.
const KNOWN_PREDICATES = Object.freeze([
  "always", "anyOf", "subagent_type", "descriptionRegex", "promptRegex",
  "promptLengthUnder", "promptLengthOver", "background",
]);

function unknownPredicates(match) {
  if (!match || typeof match !== "object") return [];
  return Object.keys(match).filter((k) => !KNOWN_PREDICATES.includes(k));
}

const alwaysMatches = (match) =>
  match && typeof match === "object" && match.always === true && Object.keys(match).length === 1;

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
    for (const key of unknownPredicates(rule?.match)) {
      problems.push(`${label}: unknown match predicate "${key}", so this rule can never fire`);
    }
    for (const sub of Array.isArray(rule?.match?.anyOf) ? rule.match.anyOf : []) {
      for (const key of unknownPredicates(sub)) {
        problems.push(`${label}: unknown match predicate "${key}" inside anyOf`);
      }
    }
    for (const field of REGEX_FIELDS) {
      const pattern = rule?.match?.[field];
      if (pattern === undefined) continue;
      const trap = escapeTrap(pattern);
      if (trap) problems.push(`${label}: ${field} ${trap}`);
      try {
        compileRegex(pattern);
      } catch (err) {
        problems.push(`${label}: ${field} is not a valid pattern (${err.message})`);
      }
    }
  });

  const catchAll = rules.findIndex((r) => alwaysMatches(r?.match));
  if (catchAll >= 0 && catchAll < rules.length - 1) {
    const dead = rules.length - catchAll - 1;
    problems.push(
      `rule #${catchAll} matches everything, so the ${dead} rule(s) after it can never fire`,
    );
  }

  return problems;
}

// Not wrong, but likely to disappoint. Descriptions are short model-authored
// prose: observed spawns were all "Research X", so a verb list built around
// "search" or "fetch" matches nothing. The prompt is far longer and steadier.
export function lintPolicy(policy) {
  const notes = [];
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  rules.forEach((rule, i) => {
    const keys = Object.keys(rule?.match ?? {});
    if (keys.length === 1 && keys[0] === "descriptionRegex") {
      notes.push(
        `${rule?.name ? `rule "${rule.name}"` : `rule #${i}`}: matches only on the description, ` +
        "which the model writes freely. Consider promptRegex or promptLengthUnder as well.",
      );
    }
  });
  return notes;
}

// Answers "which rule would fire for a spawn that looks like this?" - the thing
// you actually want when a rule is not doing what you expected.
export function explain(policy, sample) {
  const spawn = {
    description: sample?.description ?? "",
    prompt: sample?.prompt ?? "",
    subagentType: sample?.subagentType ?? null,
    background: sample?.background === true,
  };
  const verdict = evaluate(policy, spawn);
  return { ...verdict, matched: verdict.ruleIndex >= 0 };
}
