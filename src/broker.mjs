import { openSync, closeSync, writeFileSync, readFileSync, renameSync, existsSync,
         mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gateHome } from "./config.mjs";
import { countSiblings } from "./transcript.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULTS = Object.freeze({
  openAfterMs: 900,     // Show the dialog almost immediately; rows stream in after.
  minCoalesceMs: 1_500,
  // Measured inter-arrival gaps between siblings of one message: ~1.4s for
  // trivial spawns, ~4.5s when the model writes long prompts. The runtime gives
  // no count to wait for, so the window has to outlast the largest real gap.
  quietMs: 7_000,
  maxCoalesceMs: 45_000,
  pollMs: 120,
  timeoutMs: 90_000,
  staleLockMs: 180_000,  // A lock older than this belonged to a process that died.
});

// PreToolUse fires once per spawn in its own process, with no knowledge of its
// siblings. Every spawn from one assistant turn shares a prompt_id, so that is
// the batch key: one directory per turn, one leader at a time, one dialog.
function sessionDir(spawn, env) {
  return join(gateHome(env), "sessions", spawn.promptId || spawn.sessionId || "unknown");
}

const pendingFile = (dir, id) => join(dir, `${id}.pending.json`);
const decidedFile = (dir, id) => join(dir, `${id}.decided.json`);
const lockFile = (dir) => join(dir, "leader.lock");

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Exclusive create is the lock. Whoever wins runs a dialog round.
function acquire(dir, staleMs) {
  const file = lockFile(dir);
  try {
    const fd = openSync(file, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs > staleMs) {
        rmSync(file, { force: true });
        return acquire(dir, staleMs);
      }
    } catch {
      // Lock vanished between the failed create and the stat: race lost, retry later.
    }
    return false;
  }
}

// Releasing matters as much as acquiring. A sibling that arrives after the
// dialog closed must be able to take over and run its own round, rather than
// polling a lock that is never coming back.
function release(dir) {
  try {
    rmSync(lockFile(dir), { force: true });
  } catch { /* nothing useful to do */ }
}

function undecided(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".pending.json"))
      .map((f) => readJson(join(dir, f)))
      .filter((row) => row && !existsSync(decidedFile(dir, row.toolUseId)))
      .sort((a, b) => String(a.toolUseId).localeCompare(String(b.toolUseId)));
  } catch {
    return [];
  }
}

// Spawns in one turn do not arrive together: observed gaps over a second. A
// fixed window either cuts the batch short or delays every gate, so wait for
// the arrivals to go quiet instead, with a hard ceiling.
// Feeds rows to an already-open dialog while the fan-out is still arriving, and
// marks the batch final once it settles. Returns when no more spawns are coming.
async function feedRows(dir, opts, spawn, rowsPath) {
  const start = Date.now();
  let count = undecided(dir).length;
  let lastChange = Date.now();
  let expected = 0;

  while (Date.now() - start < opts.maxCoalesceMs) {
    await sleep(opts.pollMs);

    // A lower bound, not a target: the transcript can be a step ahead of the
    // hooks, so never close the batch while it knows about a spawn we have not
    // seen register yet.
    const known = countSiblings(spawn?.transcriptPath, spawn?.toolUseId);
    if (known !== null && known > expected) expected = known;

    const rows = undecided(dir);
    if (rows.length !== count) {
      count = rows.length;
      lastChange = Date.now();
      writeAtomic(rowsPath, {
        rows,
        final: false,
        settleAt: Math.max(start + opts.minCoalesceMs, lastChange + opts.quietMs),
      });
    }
    if (Date.now() - start < opts.minCoalesceMs) continue;
    if (expected && rows.length < expected) continue;
    if (Date.now() - lastChange >= opts.quietMs) break;
  }
  writeAtomic(rowsPath, { rows: undecided(dir), final: true, settleAt: Date.now() });
}

async function runRound({ dir, askUser, opts, promptId, spawn }) {
  const rowsPath = join(dir, "rows.json");
  try {
    // Open fast. Waiting for the whole fan-out before showing anything means
    // staring at nothing for ~18s; rows arrive in the open window instead.
    const openedAt = Date.now();
    const firstSettle = openedAt + Math.max(opts.minCoalesceMs, opts.quietMs);
    writeAtomic(rowsPath, { rows: undecided(dir), final: false, settleAt: firstSettle });
    await sleep(opts.openAfterMs);
    const seed = undecided(dir);
    if (seed.length === 0) return;
    writeAtomic(rowsPath, { rows: seed, final: false, settleAt: firstSettle });

    const dialog = askUser(seed, { promptId, timeoutMs: opts.timeoutMs, rowsFile: rowsPath });
    const feeding = feedRows(dir, opts, spawn, rowsPath).catch(() => {});

    const answers = await dialog;
    await feeding;

    for (const row of undecided(dir)) {
      const answer = answers?.[row.toolUseId];
      // Anything the user never saw stays undecided and starts a fresh round.
      if (answer) writeAtomic(decidedFile(dir, row.toolUseId), { ...answer, via: "dialog" });
    }
  } catch {
    // The dialog failed or timed out: release everyone unchanged.
    for (const row of undecided(dir)) {
      writeAtomic(decidedFile(dir, row.toolUseId), {
        approved: true, model: null, remember: false, via: "timeout",
      });
    }
  } finally {
    release(dir);
  }
}

// Resolves to the decision for THIS spawn. Every failure path resolves to
// "allow unchanged" rather than rejecting: a gate that hard-fails a turn
// because a lock went wrong is a gate that gets uninstalled.
export async function decide({ spawn, effective, askUser, options = {}, env = process.env }) {
  const opts = { ...DEFAULTS, ...options };
  const passthrough = { approved: true, model: null, remember: false, via: "fallback" };

  let dir;
  try {
    dir = sessionDir(spawn, env);
    mkdirSync(dir, { recursive: true });
  } catch {
    return passthrough;
  }

  const id = spawn.toolUseId || `pid-${process.pid}`;

  try {
    writeAtomic(pendingFile(dir, id), {
      toolUseId: id,
      description: spawn.description,
      subagentType: spawn.subagentType,
      prompt: spawn.prompt.slice(0, 400),
      effectiveModel: effective.model,
      effectiveSource: effective.source,
    });
  } catch {
    return passthrough;
  }

  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const mine = readJson(decidedFile(dir, id));
    if (mine) return mine;

    // Either nobody has led yet, or the previous leader finished without
    // covering us. Both cases are answered by taking the lock and leading.
    if (acquire(dir, opts.staleLockMs)) {
      await runRound({ dir, askUser, opts, promptId: spawn.promptId, spawn });
      continue;
    }
    await sleep(opts.pollMs);
  }
  return { ...passthrough, via: "timeout" };
}

// Session directories are small but they accumulate. Best effort, never fatal.
export function prune(env = process.env, maxAgeMs = 86_400_000) {
  try {
    const root = join(gateHome(env), "sessions");
    if (!existsSync(root)) return 0;
    let removed = 0;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      try {
        if (Date.now() - statSync(dir).mtimeMs > maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* skip */ }
    }
    return removed;
  } catch {
    return 0;
  }
}
