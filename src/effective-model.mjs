import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

// Built-in agent types (general-purpose, Explore, Plan) are compiled into the
// binary and have no definition file, so this returns null for them.
export function readAgentFrontmatterModel(subagentType, cwd) {
  if (!subagentType) return null;
  const roots = [
    cwd ? join(cwd, ".claude", "agents") : null,
    join(homedir(), ".claude", "agents"),
  ].filter(Boolean);

  for (const root of roots) {
    const file = join(root, `${subagentType}.md`);
    if (!existsSync(file)) continue;
    try {
      const block = FRONTMATTER.exec(readFileSync(file, "utf8"));
      if (!block) continue;
      const line = block[1].split(/\r?\n/).find((l) => /^\s*model\s*:/.test(l));
      if (!line) continue;
      const value = line.replace(/^\s*model\s*:/, "").trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      // Unreadable definition is not a reason to break a spawn.
    }
  }
  return null;
}

// Resolution order verified on v2.1.228:
//   CLAUDE_CODE_SUBAGENT_MODEL > per-call model > frontmatter model > inherit
export function resolveEffectiveModel(spawn, env = process.env) {
  const override = env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (override) {
    return Object.freeze({ model: override, source: "env", overridable: false });
  }
  if (spawn.requestedModel) {
    return Object.freeze({ model: spawn.requestedModel, source: "tool-input", overridable: true });
  }
  const frontmatter = readAgentFrontmatterModel(spawn.subagentType, spawn.cwd);
  if (frontmatter && frontmatter !== "inherit") {
    return Object.freeze({ model: frontmatter, source: "frontmatter", overridable: true });
  }
  return Object.freeze({ model: "inherit", source: "inherit", overridable: true });
}
