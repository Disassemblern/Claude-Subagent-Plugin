import { readFileSync } from "node:fs";

// Verified against Claude Code v2.1.228: the spawn tool is named "Agent".
// "Task" is a registered alias and still matches, so branch on both.
export const SPAWN_TOOLS = Object.freeze(["Agent", "Task"]);

export function readPayload(fd = 0) {
  return JSON.parse(readFileSync(fd, "utf8"));
}

export function isSpawn(payload) {
  return SPAWN_TOOLS.includes(payload?.tool_name);
}

// Normalises the hook payload into the shape the rest of the gate reasons about.
// Keeps the original tool_input intact: updatedInput replaces the whole object,
// so every field has to be echoed back untouched.
export function describeSpawn(payload) {
  const input = payload?.tool_input ?? {};
  return Object.freeze({
    toolName: payload?.tool_name ?? null,
    toolUseId: payload?.tool_use_id ?? null,
    promptId: payload?.prompt_id ?? null,
    sessionId: payload?.session_id ?? null,
    cwd: payload?.cwd ?? null,
    transcriptPath: payload?.transcript_path ?? null,
    permissionMode: payload?.permission_mode ?? null,
    subagentType: input.subagent_type ?? null,
    description: input.description ?? "",
    prompt: input.prompt ?? "",
    requestedModel: input.model ?? null,
    background: input.run_in_background === true,
    isolation: input.isolation ?? null,
    input,
  });
}
