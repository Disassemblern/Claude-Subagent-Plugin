# claude-subagent-gate

Control which model Claude Code subagents run on, before they spawn.

Claude Code subagents inherit the main conversation's model by default. When you
run Opus or Fable as your main model, a subagent whose whole job is "read this
file and list the versions" inherits it too, and you pay Opus rates for work
Haiku would do identically.

This is a `PreToolUse` hook that intercepts every subagent spawn, matches it
against a policy you write, and rewrites the model before the subagent starts.

## What it does, honestly

| | Status |
|---|---|
| Report every spawn: task, type, effective model | Yes, to a JSONL audit log |
| Rewrite the model per subagent | Yes |
| Reduce the number of subagents | Yes, by denying individual spawns |
| Increase the number of subagents | No. A hook cannot create tool calls |
| Interactive approval dialog with a model dropdown | Not in v0.1. See the roadmap |

v0.1 is the enforcement half: policy-driven, silent, no prompts. That is where
almost all of the cost saving is, and it rests only on mechanisms verified
against a real installation.

## Requirements

Claude Code v2.1.228 or compatible, and Node 18+. No runtime dependencies.

## Install

```bash
git clone https://github.com/<you>/claude-subagent-gate
cd claude-subagent-gate
node install.mjs
```

This backs up `~/.claude/settings.json`, appends a `PreToolUse` hook without
touching your other hooks, and writes a starter policy to
`~/.claude/subagent-gate/policy.json`. Restart Claude Code afterwards.

```bash
node install.mjs --project     # install into ./.claude/settings.json instead
node install.mjs --check       # validate the policy, show resolved paths
node install.mjs --uninstall   # remove only this hook
```

Run `--check` after editing your policy. Broken rules fail silently at spawn
time, which is exactly when you will not notice them.

## Policy

`~/.claude/subagent-gate/policy.json`. First matching rule wins; if nothing
matches, `fallback` applies.

```json
{
  "fallback": "allow",
  "rules": [
    {
      "name": "cheap-retrieval",
      "match": { "descriptionRegex": "(?i)\b(fetch|read|list|grep|find|search)\b" },
      "action": "force-model",
      "model": "haiku"
    },
    {
      "name": "short-tasks-are-not-hard",
      "match": { "promptLengthUnder": 400 },
      "action": "force-model",
      "model": "haiku"
    }
  ]
}
```

### Match predicates

Every predicate present on a `match` must hold. An empty `match` never matches,
so a typo cannot silently become a catch-all.

| Predicate | Matches when |
|---|---|
| `subagent_type` | The agent type equals this string, or is in this array |
| `descriptionRegex` | The spawn's description matches |
| `promptRegex` | The subagent's prompt matches |
| `promptLengthUnder` | Prompt is shorter than N characters |
| `promptLengthOver` | Prompt is longer than N characters |
| `background` | `run_in_background` equals this boolean |
| `always` | Set to `true` to match everything |

Patterns accept a leading inline flag group such as `(?i)`, which is translated
into real RegExp flags. Plain JavaScript would throw on that.

### Actions

| Action | Effect |
|---|---|
| `allow` | Pass through untouched. The hook writes nothing |
| `force-model` | Rewrite the spawn's model. Requires `model` |
| `prompt` | Surface the built-in confirm dialog, with the spawn summarised |
| `deny` | Block this spawn. `reason` is passed back to the model verbatim |

## Audit log

Every spawn is recorded as one JSON line in
`~/.claude/subagent-gate/audit.jsonl`:

```json
{"ts":"...","subagent_type":"general-purpose","description":"Reply RED",
 "requested_model":null,"effective_model":"inherit","action":"force-model",
 "outcome":"force-model","forced_model":"haiku","rule_name":"short-tasks-are-cheap"}
```

`outcome` distinguishes a rewrite that applied from one that was a no-op, which
matters when you are working out why a rule did nothing.

The log is written by the hook itself rather than scraped from transcripts, on
purpose: interactive sessions buffer subagent transcripts until a clean exit, so
a killed session leaves nothing to read.

## How model resolution works

Verified on v2.1.228. Highest priority first:

1. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
2. The per-call `model` on the spawn, which is what this hook rewrites
3. `model:` in the agent's frontmatter file
4. `inherit`, meaning the main conversation's model

Two consequences worth knowing. Built-in agent types such as `general-purpose`
are compiled into the binary and have no frontmatter file, so step 3 cannot help
you there. And if `CLAUDE_CODE_SUBAGENT_MODEL` is set it outranks this hook
entirely, silently defeating every `force-model` rule. `--check` warns you when
it is set.

## Fail-open guarantee

On unparseable input, a missing or broken policy, an unreadable agent file, or
any internal error, the hook writes nothing and exits 0, and the spawn proceeds
exactly as it would have without the gate. A hook that can break your session is
a hook nobody should install.

## Caveats

This depends on behavior that is not publicly documented. The hooks
documentation states that `PreToolUse` cannot modify tool input; on v2.1.228 it
demonstrably can, and this project is built on that. The behavior was verified
end to end, in both headless and interactive sessions, by rewriting a spawn and
confirming the subagent transcript recorded the substituted model.

Pin your expectations to the tested version. If a future release changes this,
the gate degrades to doing nothing rather than breaking, but your rules will
stop having any effect.

Also note that `subagent_type: "fork"` is documented to always inherit the parent
model, so a model rewrite is expected to be ignored for forks.

## Development

```bash
node --test
```

29 tests covering rule matching, decision building, model resolution, installer
roundtrips, and end-to-end hook invocation with captured real payloads.

## Roadmap

- v0.2: an approval dialog with a per-spawn model dropdown, a leader-lock broker
  so parallel spawns produce one window rather than several, and a
  remember-this-rule button that writes back into the policy
- v0.3: batch grouping by `prompt_id`, and a report of estimated tokens saved
- v0.4: cross-platform UI adapters, with a localhost browser fallback as the
  default so this is not a Windows-only tool

## License

MIT
