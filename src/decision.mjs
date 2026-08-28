const MAX_PREVIEW = 160;

const preview = (text) =>
  text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}...` : text;

export function summarize(spawn, effective) {
  return [
    "Subagent gate",
    `  task:  ${spawn.description || "(no description)"}`,
    `  type:  ${spawn.subagentType || "(default)"}`,
    `  model: ${effective.model} (from ${effective.source})`,
    `  prompt: ${preview(spawn.prompt)}`,
  ].join("\n");
}

const output = (permissionDecision, extra = {}) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision,
    ...extra,
  },
});

// Returns the object to write to stdout, or null to stay silent and let the
// spawn proceed untouched. Silence is the safest possible response.
export function buildDecision(verdict, spawn, effective) {
  switch (verdict.action) {
    case "force-model": {
      const target = verdict.model;
      // Nothing to do, or nothing we are allowed to do.
      if (!target) return null;
      if (!effective.overridable) return null;
      if (target === effective.model) return null;
      // updatedInput replaces the entire input object, so spread the original.
      return output("allow", { updatedInput: { ...spawn.input, model: target } });
    }

    case "prompt":
      return output("ask", { permissionDecisionReason: summarize(spawn, effective) });

    case "deny":
      return output("deny", {
        permissionDecisionReason:
          verdict.reason ?? "Subagent gate declined this spawn. Do not retry it.",
      });

    case "allow":
    default:
      return null;
  }
}

// What actually happened, for the audit trail. Distinguishes a force-model that
// applied from one that was a no-op, which matters when reading the log later.
export function outcomeOf(verdict, decision, effective) {
  if (verdict.action !== "force-model") return verdict.action;
  if (decision) return "force-model";
  if (!effective.overridable) return "force-model-blocked-by-env";
  return "force-model-noop";
}
