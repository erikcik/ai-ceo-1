# lh-harness-eray (sdk)

```bash
npm install && npm run build:web
node bin/lh-harness-eray.mjs doctor
node bin/lh-harness-eray.mjs init
node bin/lh-harness-eray.mjs web --workspace-root .
node bin/lh-harness-eray.mjs run --task @task.md
npm test            # node:test suites (tests/loop/ covers the loop end to end with a scripted adapter)
npm run typecheck
```

## Module map

| path | what |
|---|---|
| `src/loop/runner.ts` | the loop: `run()` crash boundary → `runImpl()` schedule → `phaseIntake/Tailor/Plan/Execute/Finalize`, `runSubtask` (rubric → [context → composer → evaluator]×N), human gates, report |
| `src/loop/plan.ts` | plan tree types, `parsePlan`, `nextReadyLeaf` (dependency order), `applyPlanChanges` (evaluator/operator edits), markdown rendering |
| `src/loop/state.ts` | `RunState`: every file under `<run>/state/`, contracts + evaluations parsing, the contract pass rule, `readLoopSnapshot` for the workbench |
| `src/loop/hooks.ts` | Agent SDK hooks: kill switch/steering, write scopes, evidence ledger, composer stop gate |
| `src/loop/context.ts` + `context_selector.py` | decides (deterministically, with reasons) what the composer sees each round |
| `src/loop/prompts.ts` + `prompts/*.md` | role prompts: `common.md` + `<role>.md` + tailored briefing + episode inputs |
| `src/loop/subagents.ts` | `web-researcher`, `memory-curator`, `rubric-researcher`, `evaluation-researcher` |
| `src/loop/memory.ts` | the Karpathy-style wiki: index regeneration, log |
| `src/loop/episodes.ts` | run one episode, record it (`<logDir>/<role>_episodes/epNNN`), append events |
| `src/adapters/claude_code.ts`, `claude_permissions.ts` | `query()` backend, per-role tool policies, evaluator snapshot guard |
| `src/providers.ts`, `shim.ts`, `providers.json` | third-party model routing |
| `src/capabilities.ts` | per-run external-tool grants (env + MCP + prompt note) |
| `src/supervisor/*` | worker process lifecycle, control bus, resume |
| `src/webapi/*` | HTTP + WS API; `snapshot.ts` builds the workbench snapshot (`loop`, `active_subtask`, …) |
| `src/dashboard/state.ts`, `gate.ts` | on-disk projection + approvals; the human gate triggers |
| `src/cli.ts`, `config.ts` | `init · run · web · dashboard · doctor · plugin · check-update · start`; `config.toml` |
| `frontend/` | React workbench (plan graph + node panel) |

## Roles and what they may do

| role | tools | writes | subagents | notes |
|---|---|---|---|---|
| prompt_tailor | Read/Glob/Grep | nothing (harness stores its output) | no | one short session |
| planner | everything incl. browser, WebSearch | `state/research`, `state/plan/PLAN.md`, `memory/`, `inbox/` | yes | ≥ `min_research_agents` researchers |
| rubric | Read/Glob/Grep/WebSearch/WebFetch | `state/rubrics`, `memory/` | yes | contract JSON parsed by the harness |
| composer | everything | workspace + `state/progress`, `state/evidence`; **not** contracts/evaluations/plan | yes | ledger + stop gate hooks |
| evaluator | everything incl. browser/computer use | `memory/` only; snapshot guard flags any other mutation | yes | verdict checked against the contract rule |
| final_response | Read | nothing | no | |

## Third-party model providers

`providers.json` declares Anthropic- or OpenAI-compatible endpoints; a model id
`<provider>:<model>` routes that role through the local shim. `WebSearch`/`WebFetch` (and
therefore research subagents) are unavailable behind a third-party base URL.
