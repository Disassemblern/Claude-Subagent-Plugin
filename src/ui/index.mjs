import * as winforms from "./winforms.mjs";
import * as browser from "./browser.mjs";

// Order is preference order. WinForms is the nicer experience on Windows;
// the browser adapter works everywhere, so it is always the final fallback.
const ADAPTERS = [winforms, browser];

export function pickAdapter(env = process.env) {
  const forced = env.SUBAGENT_GATE_UI;
  if (forced === "none") return null;
  if (forced) return ADAPTERS.find((a) => a.name === forced) ?? null;
  return ADAPTERS.find((a) => a.available()) ?? null;
}

export function uiAvailable(env = process.env) {
  return pickAdapter(env) !== null;
}

// Returns decisions keyed by toolUseId. Throws on timeout or dialog failure so
// the broker can fall back to leaving every spawn unchanged.
export async function askUser(rows, opts, env = process.env) {
  const adapter = pickAdapter(env);
  if (!adapter) throw new Error("no UI adapter available");
  const response = await adapter.ask(rows, opts, env);
  if (!response || response.result === "timeout") throw new Error("dialog timed out");
  return response.decisions ?? {};
}
