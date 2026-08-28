#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, policyPath, auditPath, ensureDir } from "./src/config.mjs";
import { validatePolicy } from "./src/policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = join(HERE, "src", "index.mjs");
const MATCHER = "Agent|Task";
const MARKER = "subagent-gate";

const say = (msg) => process.stdout.write(`${msg}\n`);

const settingsFile = (scope) =>
  scope === "project"
    ? join(process.cwd(), ".claude", "settings.json")
    : join(homedir(), ".claude", "settings.json");

const readJson = (file, fallback) => {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // Signals "present but unparseable" so we refuse to overwrite.
  }
};

const hookCommand = () => `node "${HOOK_ENTRY.split("\\").join("/")}" --${MARKER}`;

const isOurs = (group) =>
  Array.isArray(group?.hooks) &&
  group.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER));

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.backup-${stamp}`;
  copyFileSync(file, target);
  return target;
}

function install(scope) {
  const file = settingsFile(scope);
  const settings = readJson(file, {});
  if (settings === null) {
    say(`Refusing to touch ${file}: it exists but is not valid JSON. Fix it first.`);
    process.exitCode = 1;
    return;
  }

  if (existsSync(file)) say(`Backed up to ${backup(file)}`);

  const pre = settings.hooks?.PreToolUse ?? [];
  const withoutOurs = pre.filter((group) => !isOurs(group));
  const entry = {
    matcher: MATCHER,
    hooks: [{ type: "command", command: hookCommand(), timeout: 60 }],
  };

  const next = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}), PreToolUse: [...withoutOurs, entry] },
  };

  ensureDir(file);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  say(`Installed the subagent gate into ${file}`);

  const policy = policyPath();
  if (!existsSync(policy)) {
    ensureDir(policy);
    copyFileSync(join(HERE, "policy.example.json"), policy);
    say(`Wrote a starter policy to ${policy}`);
  } else {
    say(`Kept your existing policy at ${policy}`);
  }

  say("");
  say("Restart Claude Code for the hook to take effect.");
  check();
}

function uninstall(scope) {
  const file = settingsFile(scope);
  const settings = readJson(file, null);
  if (!settings) {
    say(`Nothing to do: ${file} is missing or unreadable.`);
    return;
  }
  const pre = settings.hooks?.PreToolUse ?? [];
  const kept = pre.filter((group) => !isOurs(group));
  if (kept.length === pre.length) {
    say("The gate is not installed in that settings file.");
    return;
  }
  say(`Backed up to ${backup(file)}`);
  const next = { ...settings, hooks: { ...settings.hooks, PreToolUse: kept } };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  say(`Removed the subagent gate from ${file}`);
}

function check() {
  say("");
  say("Configuration");
  say(`  hook     ${HOOK_ENTRY}`);
  say(`  policy   ${policyPath()}`);
  say(`  audit    ${auditPath()}`);

  const { policy, source, error } = loadPolicy();
  if (error) {
    say(`  policy is unreadable (${error}). The gate will allow everything.`);
    process.exitCode = 1;
    return;
  }
  say(`  source   ${source}`);

  const problems = validatePolicy(policy);
  if (problems.length === 0) {
    const count = Array.isArray(policy.rules) ? policy.rules.length : 0;
    say(`  ${count} rule(s), no problems found.`);
  } else {
    say("");
    say("Problems in your policy:");
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 1;
  }

  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    say("");
    say(`WARNING: CLAUDE_CODE_SUBAGENT_MODEL is set to "${process.env.CLAUDE_CODE_SUBAGENT_MODEL}".`);
    say("It outranks this hook, so every force-model rule will be ignored while it is set.");
  }
}

const args = process.argv.slice(2);
const scope = args.includes("--project") ? "project" : "global";

if (args.includes("--help") || args.includes("-h")) {
  say("subagent-gate [--project] [--uninstall | --check]");
  say("  (no flags)    install into ~/.claude/settings.json");
  say("  --project     use ./.claude/settings.json instead");
  say("  --uninstall   remove the hook, leaving other hooks untouched");
  say("  --check       validate the policy and show resolved paths");
} else if (args.includes("--uninstall")) {
  uninstall(scope);
} else if (args.includes("--check")) {
  check();
} else {
  install(scope);
}
