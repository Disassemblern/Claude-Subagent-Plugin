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
- `options`: 2-4 models worth considering for THAT agent, each with a one-line
  description of the tradeoff. Four is a hard cap, so pick the set per agent
  rather than always offering the same four.

Choose from `haiku`, `sonnet`, `opus`, `fable`, `inherit` and `skip`:

- A small agent (a grep, a count, a short lookup): `haiku`, `sonnet`, `opus`,
  `skip`.
- A large or open-ended agent: `sonnet`, `opus`, `fable`, `skip`. Offering
  `haiku` for deep research spends a slot on an answer nobody will pick.
- `skip` earns its slot nearly always. It is the only way to call an agent off,
  and the gate enforces it by denying that spawn.
- `inherit` means "run on whatever the main conversation runs on". Offer it
  only when the subagent genuinely needs parity with the parent. It is the
  silent expensive default this gate exists to make visible, so it is rarely
  the right answer.

The user can always type an answer through "Other", so a model left off the
list is still reachable. Never spend a slot on an option nobody will choose.

**Put your recommendation first and mark it.** Label it `haiku (Recommended)`
and order the rest after it. You have read the task and the user has not, so
you are better placed to size it: making your pick the first option means
accepting it is one keypress, while overriding it stays exactly as easy. That
is how the user hands you the choice without giving up sight of it.

Bias the recommendation cheap. When two models would both do the job, name the
smaller one — this gate exists because subagents silently inherit a frontier
model for work that never needed one.

A recommendation is not a preset. Every agent still gets its own question and
its own answer; do not collapse them back into one bundled choice.

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
