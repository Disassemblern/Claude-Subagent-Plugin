import { existsSync, readFileSync } from "node:fs";
import { auditPath } from "./config.mjs";

export function readRecords(env = process.env) {
  const file = auditPath(env);
  if (!existsSync(file)) return { file, records: [], unreadable: 0 };

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { file, records: [], unreadable: 0 };
  }

  const records = [];
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      unreadable += 1; // A half-written last line is normal while a turn is live.
    }
  }
  return { file, records, unreadable };
}

export function parseSince(spec) {
  const m = /^(\d+)\s*([hd])$/i.exec(String(spec ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "h" ? n * 3_600_000 : n * 86_400_000;
}

const bump = (map, key) => {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
};

const sortedEntries = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

// A spawn that reached the model unchanged still had a decision made about it,
// so "gated" counts every spawn the hook saw, not only the ones it altered.
export function summarise(records, { sinceMs, now } = {}) {
  const cutoff = sinceMs ? now - sinceMs : null;
  const kept = cutoff
    ? records.filter((r) => {
        const t = Date.parse(r?.ts ?? "");
        return Number.isFinite(t) && t >= cutoff;
      })
    : records;

  const byOutcome = new Map();
  const byRule = new Map();
  const transitions = new Map();
  let blocked = 0;
  let changed = 0;
  let reaffirmed = 0;

  for (const r of kept) {
    bump(byOutcome, r?.outcome ?? "unknown");
    bump(byRule, r?.rule_name ?? "(none)");

    if (r?.forced_model) {
      const from = r.effective_model ?? "inherit";
      // The model sometimes sets the right model itself and the gate merely
      // agrees. That is not a change, and counting it would flatter the report.
      if (from === r.forced_model) {
        reaffirmed += 1;
      } else {
        changed += 1;
        bump(transitions, `${from} -> ${r.forced_model}`);
      }
    }
    const outcome = String(r?.outcome ?? "");
    if (outcome === "deny" || outcome === "gate-denied" || outcome === "plan-skipped" ||
        outcome.startsWith("plan-no-plan") || outcome === "plan-not-in-plan" ||
        outcome === "plan-stale-plan" || outcome === "plan-wrong-cwd") {
      blocked += 1;
    }
  }

  const times = kept.map((r) => Date.parse(r?.ts ?? "")).filter(Number.isFinite).sort();

  return {
    total: kept.length,
    changed,
    reaffirmed,
    blocked,
    byOutcome: sortedEntries(byOutcome),
    byRule: sortedEntries(byRule),
    transitions: sortedEntries(transitions),
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times[times.length - 1]).toISOString() : null,
  };
}

export function parseRates(spec) {
  if (!spec) return null;
  const rates = {};
  for (const pair of String(spec).split(",")) {
    const [name, value] = pair.split("=").map((s) => s?.trim());
    const n = Number(value);
    if (!name || !Number.isFinite(n) || n <= 0) return null;
    rates[name.toLowerCase()] = n;
  }
  return Object.keys(rates).length ? rates : null;
}

// Deliberately NOT money. The audit records which model ran, never how many
// tokens it used, so any dollar figure would be invented. This compares the
// weight of what ran against what would have run, and only when the user
// supplies the weights.
export function costIndex(summary, rates) {
  if (!rates) return null;
  let before = 0;
  let after = 0;
  let counted = 0;
  let unpriced = 0;

  for (const [transition, count] of summary.transitions) {
    const [from, to] = transition.split(" -> ").map((s) => s.trim().toLowerCase());
    const fromRate = rates[from];
    const toRate = rates[to];
    if (fromRate === undefined || toRate === undefined) {
      unpriced += count;
      continue;
    }
    before += fromRate * count;
    after += toRate * count;
    counted += count;
  }

  if (!counted) return { counted: 0, unpriced, ratio: null };
  return { counted, unpriced, before, after, ratio: after / before };
}
