import { readFileSync } from "node:fs";

const SPAWN_NAMES = new Set(["Agent", "Task"]);

// One assistant message is persisted as one JSONL line per tool_use block, all
// sharing message.id, each written as its spawn is dispatched. So this is a
// LOWER BOUND on the fan-out, never the total: the runtime offers no lookahead,
// and the last sibling appears here at the same moment its hook fires.
// Useful anyway, because a line can land slightly before its hook registers.
export function countSiblings(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId) return null;

  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  let messageId = null;
  const spawnIds = new Set();

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A half-written trailing line is normal while a turn is live.
    }
    const message = entry?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    const spawns = message.content.filter(
      (b) => b?.type === "tool_use" && SPAWN_NAMES.has(b.name),
    );
    if (spawns.length === 0) continue;

    if (spawns.some((b) => b.id === toolUseId)) messageId = message.id;
    if (message.id) {
      for (const b of spawns) spawnIds.add(`${message.id}:${b.id}`);
    }
  }

  if (!messageId) return null;
  let count = 0;
  for (const key of spawnIds) if (key.startsWith(`${messageId}:`)) count += 1;
  return count || null;
}
