#!/usr/bin/env node
import { loadPolicy, policyPath, auditPath, gateHome } from "../src/config.mjs";
import { validatePolicy, lintPolicy, explain } from "../src/policy.mjs";
import { planPath, readPlan } from "../src/approval.mjs";
import { readRecords, summarise, parseSince, parseRates, costIndex } from "../src/report.mjs";

const say = (msg = "") => process.stdout.write(`${msg}\n`);

const flag = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function check() {
  say("Configuration");
  say(`  home     ${gateHome()}`);
  say(`  policy   ${policyPath()}`);
  say(`  plan     ${planPath()}`);
  say(`  audit    ${auditPath()}`);
  say("");

  const { policy, source, error } = loadPolicy();
  if (error) {
    say(`Policy is unreadable (${error}).`);
    say("The gate will allow every spawn through until this is fixed.");
    process.exitCode = 1;
    return;
  }
  say(`Policy source: ${source}`);

  const problems = validatePolicy(policy);
  const notes = lintPolicy(policy);
  const ruleCount = Array.isArray(policy.rules) ? policy.rules.length : 0;

  if (problems.length === 0) {
    say(`${ruleCount} rule(s), no problems found.`);
  } else {
    say("");
    say("Problems:");
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 1;
  }

  if (notes.length) {
    say("");
    say("Advisories:");
    for (const n of notes) say(`  - ${n}`);
  }

  const plan = readPlan();
  say("");
  say(plan ? `An approved plan exists, covering ${plan.agents?.length ?? 0} agent(s).` : "No approved plan on disk.");

  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    say("");
    say(`WARNING: CLAUDE_CODE_SUBAGENT_MODEL is set to "${process.env.CLAUDE_CODE_SUBAGENT_MODEL}".`);
    say("It outranks this hook, so every model choice made here is ignored while it is set.");
  }
}

function explainCommand(args) {
  const description = flag(args, "description") ?? "";
  const type = flag(args, "type") ?? "general-purpose";
  const length = Number(flag(args, "prompt-length") ?? 0);

  if (!description && !length) {
    say("Usage: subagent-gate explain --description <text> [--prompt-length N] [--type NAME]");
    process.exitCode = 1;
    return;
  }

  const { policy, error } = loadPolicy();
  if (error) {
    say(`Policy is unreadable (${error}).`);
    process.exitCode = 1;
    return;
  }

  const verdict = explain(policy, {
    description,
    prompt: "x".repeat(Math.max(0, length)),
    subagentType: type,
  });

  say(`description   ${description || "(none)"}`);
  say(`subagent_type ${type}`);
  say(`prompt length ${length}`);
  say("");
  say(`matches       ${verdict.matched ? verdict.ruleName ?? `rule #${verdict.ruleIndex}` : "no rule (fallback)"}`);
  say(`action        ${verdict.action}`);
  if (verdict.model) say(`model         ${verdict.model}`);
}

function reportCommand(args) {
  const sinceSpec = flag(args, "since");
  const sinceMs = sinceSpec ? parseSince(sinceSpec) : null;
  if (sinceSpec && sinceMs === null) {
    say(`Could not read --since "${sinceSpec}". Use a form like 7d or 12h.`);
    process.exitCode = 1;
    return;
  }

  const ratesSpec = flag(args, "rates");
  const rates = ratesSpec ? parseRates(ratesSpec) : null;
  if (ratesSpec && !rates) {
    say(`Could not read --rates "${ratesSpec}". Use a form like haiku=1,sonnet=3,opus=15.`);
    process.exitCode = 1;
    return;
  }

  const { file, records, unreadable } = readRecords();
  if (records.length === 0) {
    say(`No audit records yet at ${file}`);
    return;
  }

  const s = summarise(records, { sinceMs, now: Date.now() });
  say(`Subagent gate report   ${file}`);
  say(`${s.total} spawn(s)${sinceSpec ? ` in the last ${sinceSpec}` : ""}${s.first ? `, ${s.first.slice(0, 10)} to ${s.last.slice(0, 10)}` : ""}`);
  if (unreadable) say(`(${unreadable} unreadable line(s) skipped)`);
  say("");

  say(`  model changed   ${s.changed}`);
  if (s.reaffirmed) say(`  already correct ${s.reaffirmed}`);
  say(`  blocked         ${s.blocked}`);
  say(`  left alone      ${s.total - s.changed - s.reaffirmed - s.blocked}`);

  if (s.transitions.length) {
    say("");
    say("Model changes");
    for (const [t, n] of s.transitions) say(`  ${String(n).padStart(5)}  ${t}`);
  }

  say("");
  say("Outcomes");
  for (const [o, n] of s.byOutcome) say(`  ${String(n).padStart(5)}  ${o}`);

  say("");
  say("Rules that fired");
  for (const [r, n] of s.byRule) say(`  ${String(n).padStart(5)}  ${r}`);

  const index = costIndex(s, rates);
  if (index && index.counted) {
    const pct = Math.round(index.ratio * 100);
    say("");
    say("Relative model cost");
    say(`  Those ${index.counted} changed spawn(s) ran at about ${pct}% of the weight they`);
    say(`  would have carried unchanged (${index.before} -> ${index.after}).`);
    say("  Assumes equal token use per spawn. The audit records which model ran,");
    say("  never how many tokens it used, so this is a weighting, not a bill.");
    if (index.unpriced) say(`  ${index.unpriced} change(s) skipped: no rate given for that model.`);
  } else if (rates) {
    say("");
    say("No model changes could be priced with the rates given.");
  }
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "check":
    check();
    break;
  case "explain":
    explainCommand(rest);
    break;
  case "report":
    reportCommand(rest);
    break;
  default:
    say("subagent-gate <command>");
    say("");
    say("  check                          validate the policy and show resolved paths");
    say("  explain --description <text>   show which rule a spawn would match");
    say("          [--prompt-length N] [--type NAME]");
    say("  report [--since 7d]            what the gate has actually done");
    say("         [--rates haiku=1,sonnet=3,opus=15]");
    if (command) process.exitCode = 1;
}
