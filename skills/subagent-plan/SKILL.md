---
name: subagent-plan
description: Get the user's approval for a subagent fan-out before spawning. Use BEFORE calling the Agent/Task tool for any reason - the spawns are blocked until an approved plan exists on disk. Triggers whenever you are about to delegate work to one or more subagents, run agents in parallel, or fan out research.
---

# Subagent plan approval

Subagent spawns on this machine are gated. The Agent tool is blocked until the
user has seen the whole plan and chosen a model for each agent. Doing this
first saves a wasted denied call.

The reason the gate exists: subagents inherit the main conversation's model, so
a task that only needs Haiku silently runs on Opus. The user wants to see every
agent before any of them starts, and pick what each one costs.

## Steps

**1. Decide the full fan-out first.** Work out every subagent you intend to
spawn this turn, with the exact `description` you will pass to each one. Do not
present a partial list and add more later — the user asked to see all of them
at once.

**2. Ask with AskUserQuestion — one question per agent.** The user wants to set
each agent's model individually. Do NOT offer bundled presets like "all haiku"
or "mixed"; those take the choice away from them.

AskUserQuestion accepts up to 4 questions in a single call, each with 2-4
options. So a fan-out of up to four agents is ONE call containing one question
per agent, answered independently. For more than four agents, make several
calls, four agents at a time.

For each agent:
- `question`: name the agent and what it will do, e.g.
  "Which model for: Research QUIC head-of-line blocking (web search, ~800 char brief)?"
  Include the size signal — a small lookup and a deep research task deserve
  different answers, and the user cannot tell them apart from a label alone.
- `header`: a short tag, 12 characters max, e.g. "QUIC" or "Reply ALPHA".
- `options`: the models worth considering for THAT agent, cheapest first, each
  with a one-line description of the tradeoff. Four is the maximum, so choose
  the four that actually make sense — usually `haiku`, `sonnet`, `opus`, and
  `skip` (do not run this agent at all). The user can always type their own
  answer, so do not spend an option slot on something unlikely.

Put the cheapest sensible model first: it is the default the user is most
likely to want for a small task, and this whole gate exists to avoid paying
frontier prices for trivial work.

**3. Write the approved plan.** Save to the path the gate names in its denial
message — by default `~/.claude/subagent-gate/approved-plan.json`:

```json
{
  "approvedAt": "2026-08-28T12:00:00Z",
  "cwd": "<the current working directory>",
  "agents": [
    { "description": "Research QUIC head-of-line blocking", "model": "sonnet" },
    { "description": "Reply ALPHA", "model": "haiku" }
  ]
}
```

- `approvedAt` must be the current UTC time in ISO 8601. Plans expire.
- `cwd` must match the directory you are working in.
- `description` must match what you pass to the Agent tool. Matching is
  case-insensitive and tolerates minor rewording, but exact is safest.
- `model` is one of `haiku`, `sonnet`, `opus`, `fable`, `inherit`, or `skip`.
  Use `skip` for an agent the user declined; do not spawn it at all.

**4. Spawn.** Issue the Agent calls using exactly those descriptions. The gate
applies the approved model to each one.

## Rules

- Never write a plan the user has not actually seen and answered. The file is a
  record of their decision, not a formality.
- If the user declines an agent, mark it `skip` and do not spawn it.
- If the fan-out changes after approval, ask again before spawning the new work.
- A denied spawn tells you exactly what went wrong. Read the message rather
  than retrying the same call.
