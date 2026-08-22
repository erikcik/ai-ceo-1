# lh-harness (TypeScript, Claude Agent SDK)

A module-for-module port of LongHorizon-Harness's `src/lh_harness/` Python
package. Same loop, same roles, same prompts, same file formats, same CLI, same
dashboard protocol — the agent episode runs through `query()` from
`@anthropic-ai/claude-agent-sdk` instead of a `claude --print` subprocess.

```bash
npm install && npm run build:web
node bin/lh-harness.mjs doctor
node bin/lh-harness.mjs init
node bin/lh-harness.mjs web --workspace-root .
node bin/lh-harness.mjs run --task @task.md
npm test                                 # node:test ports of the upstream test-suite
npm run typecheck
```

## Module map (Python → TypeScript)

| upstream `src/lh_harness/` | here `src/` | notes |
|---|---|---|
| `types.py` | `types.ts` | snake_case fields on every record that reaches disk |
| `prompt_texts.py`, `role_prompts.py` | `prompt_texts.ts`, `role_prompts.ts` | English-only: the upstream `zh` prompt catalog, route markers, and transcript headings were removed; `tests/golden/` snapshots pin the current English output |
| `manager.py` | `manager.ts` | the round loop, `events.jsonl` + `rounds.jsonl` ledgers, `report.json` schema 2, human gate, resume, continue-after-finish, final response |
| `auditor_agent.py` | `auditor_agent.ts` | control-header parsing, blocking-constraint guard, workspace-mutation cross-check |
| `runtime_signals.py`, `agent_logs.py`, `trajectory_artifacts.py` | same names | differential-tested against the Python |
| `provider_errors.py`, `agent_registry.py`, `model_catalog.py`, `config.py` | same names | registry has one backend: `claude_code`; catalog appends `<provider>:<model>` ids from `providers.json` |
| `adapters/claude_code.py`, `claude_permissions.py`, `cli_agent.py`, `base.py` | `adapters/*.ts` | role policies, path deny rules, snapshot guard; episodes via the Agent SDK |
| `environment/{base,local,remote_files}.py` | `environment/*.ts` | `local` only, as upstream |
| `supervisor/{service,control_bus,lifecycle}.py` | `supervisor/*.ts` | file-based control bus under `<run>/control/`; lockfile instead of `flock` |
| `dashboard/{state,gate,rules}.py` | `dashboard/*.ts` | snapshot projection and the five human-gate triggers |
| `webapi/{server,events,models,protocol,snapshot}.py` | `webapi/*.ts` | `node:http` + `ws`; same routes, auth, WS subprotocols, close codes |
| `plugins/*.py` | `plugins/*.ts` | `open-computer-use`, `clawdcursor` (npm MCP servers); codex plugin not ported |
| `utils/*.py` | `utils/*.ts` | + `pystr.ts` for Python string semantics |
| `cli.py` | `cli.ts` | `init · run · web · dashboard · doctor · plugin · check-update` |
| `frontend/core`, `frontend/web` | `frontend/core`, `frontend/web` | copied verbatim; pickers narrowed to `claude_code` |

Not ported, by design: the `codex`, `opencode`, `deepseek_harness` adapters and
the Codex-bundled computer-use plugin (the Agent SDK is the single backend;
third-party models go through `providers.json` + `shim.ts`), and `eval/`
(frozen benchmark snapshots).

## Third-party model providers

`providers.json` declares Anthropic-compatible or OpenAI-compatible endpoints:
base URL, the *name* of the env var holding the key, wire format, optional
`extraBody` (e.g. vLLM `chat_template_kwargs.enable_thinking=false`), and the
models to offer in the workbench. A model id `<provider>:<model>` routes that
role's episodes through the local shim (`shim.ts`): Anthropic wire → thinking
forced off; OpenAI wire → full request/response translation. The operator's
Anthropic credentials are stripped from provider-routed episodes, and
`WebSearch`/`WebFetch` are unavailable behind a third-party base URL.
