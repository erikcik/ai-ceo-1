// Ported 1:1 from LongHorizon-Harness src/lh_harness/cli.py
//
// `argparse` has no Node equivalent, so the first third of this file is a
// faithful re-implementation of the pieces `cli.py` relies on: the
// `ArgumentDefaultsHelpFormatter` + `RawDescriptionHelpFormatter` pair (with
// this project's default-suppression override), `textwrap.wrap`'s greedy
// filling with hyphen breaking, argparse's usage-line wrapping, and its error
// messages/exit codes. Everything below `--- cli.py ---` is the literal port.
//
// Port deltas, all forced by the runtime rather than chosen:
//   * `claude_code` is the only agent, so `_AGENTS`/`_PLUGIN_CHOICES` shrink and
//     the "Agent runtime" failure names only Claude Code.
//   * the Python-version doctor check becomes a Node.js runtime check.
//   * `check-update` reads npm instead of PyPI (see utils/update_check.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import child_process from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PROJECT_CONFIG_PATH,
  ProjectConfigError,
  createProjectConfig,
  loadRunDefaults,
  resolveRoleModel,
  resolveRoleOption,
  resolveRoleReasoningEffort,
} from "./config.js";
import {
  DEFAULT_STATE_ROOT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_WORKSPACE_PATH,
  HOMEPAGE,
  ISSUES_URL,
  MAX_ROUNDS,
  VERSION,
  EpisodeBudget,
  harnessConfig,
} from "./types.js";
import type { HarnessConfig, PromptLanguage } from "./types.js";
import { normaliseReasoningEffort } from "./agent_registry.js";
import { probeAgentCli } from "./utils/agent_cli.js";
import type { AgentAdapter } from "./adapters/base.js";
import type { DashboardState } from "./dashboard/state.js";
import type { Environment } from "./environment/base.js";
import {
  appendJsonl as _appendJsonlNofollow,
  atomicBytesWrite as _atomicBytesWrite,
  ensureDirNofollow as _ensureDirNofollow,
  expandUser,
  openNofollow as _openNofollow,
  jsonDumpsSorted,
} from "./supervisor/control_bus.js";
import { pyStrip } from "./utils/pystr.js";

const _EPILOG = `Homepage: ${HOMEPAGE}\nFound a bug? Please open an issue: ${ISSUES_URL}`;

// Runs are project-scoped.
const _DEFAULT_RUNS_ROOT = "./.lh-harness/runs";
const _DEFAULT_MAX_ROUNDS = DEFAULT_MAX_ROUNDS;
const _MAX_TASK_FILE_BYTES = 100_000;

// Agent backends as (choice, CLI binary, default model).  Kept literal so
// `--help` needs no registry import; `_doctorCommand` asserts it still agrees
// with `agent_registry.AGENT_SPECS`.
const _AGENTS: readonly (readonly [string, string, string])[] = [
  ["claude_code", "claude", DEFAULT_CLAUDE_MODEL],
];
const _AGENT_CHOICES: readonly string[] = _AGENTS.map(([name]) => name);
const _MCP_AGENT_CHOICES: readonly string[] = ["claude_code"];
// Each agent reads MCP config in its own format, so each gets its own flag.
const _MCP_CONFIG_DESTS: Readonly<Record<string, string>> = { claude_code: "claude_mcp_config" };

// Computer-use plugins, listed here so `--help` needs no plugins import.
// Kept in sync by a check in `_pluginCommand`.
const _PLUGIN_CHOICES: readonly string[] = ["open-computer-use", "clawdcursor", "playwright-mcp"];

// Role options as (dest prefix, broader option it falls back to, help scope).
// Each entry gets a matching `--<role>-agent` and `--<role>-model` flag;
// resolution walks the fallback chain and ends at the global --agent / --model.
const _ROLE_OPTIONS: readonly (readonly [string, string | null, string])[] = [
  ["manager", null, "the scheduler role"],
  ["executor", null, "both executor roles"],
  ["gui_executor", "executor", "GUI/visual subtasks"],
  ["cli_executor", "executor", "CLI/non-GUI subtasks"],
  ["auditor", null, "both auditor roles"],
  ["gui_auditor", "auditor", "GUI audit"],
  ["cli_auditor", "auditor", "CLI audit"],
  ["final_response", "manager", "the closing reply written for you"],
];
const _ROLE_PARENTS: Record<string, string | null> = Object.fromEntries(
  _ROLE_OPTIONS.map(([role, parent]) => [role, parent]),
);
const _ROLE_SCOPES: Record<string, string> = Object.fromEntries(
  _ROLE_OPTIONS.map(([role, , scope]) => [role, scope]),
);

// Per-role episode budgets as (dest prefix, timeout seconds). The
// executors get the long task timeout; the scheduler and auditors get the short one.
const _BUDGET_OPTIONS: readonly (readonly [string, number])[] = [
  ["manager", 300],
  ["gui_executor", 1800],
  ["cli_executor", 1800],
  ["auditor", 300],
];

// ---------------------------------------------------------------------------
// Console I/O (kept behind one indirection so tests can capture)
// ---------------------------------------------------------------------------

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function eprint(line = ""): void {
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// textwrap.wrap (defaults: break_long_words=True, break_on_hyphens=True)
// ---------------------------------------------------------------------------

const _WS = "\\t\\n\\v\\f\\r ";
const _WORD_PUNCT = "[\\w!\"'&.,?]";
const _LETTER = "[^\\d\\W]";
const _WORDSEP_RE = new RegExp(
  "(" +
    `[${_WS}]+` +
    "|" +
    `(?<=${_WORD_PUNCT})-{2,}(?=\\w)` +
    "|" +
    `[^${_WS}]+?(?:` +
    `-(?:(?<=${_LETTER}{2}-)|(?<=${_LETTER}-${_LETTER}-))(?=${_LETTER}-?${_LETTER})` +
    "|" +
    `(?=[${_WS}]|$)` +
    "|" +
    `(?<=${_WORD_PUNCT})(?=-{2,}\\w)` +
    "))",
);

function _isBlank(chunk: string): boolean {
  return chunk.trim() === "";
}

/** `textwrap.TextWrapper._handle_long_word`. */
function _handleLongWord(
  reversedChunks: string[],
  curLine: string[],
  curLen: number,
  width: number,
): void {
  const spaceLeft = width < 1 ? 1 : width - curLen;
  const chunk = reversedChunks[reversedChunks.length - 1] as string;
  let end = spaceLeft;
  if (chunk.length > spaceLeft) {
    const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
    if (hyphen > 0 && [...chunk.slice(0, hyphen)].some((character) => character !== "-")) {
      end = hyphen + 1;
    }
  }
  curLine.push(chunk.slice(0, end));
  reversedChunks[reversedChunks.length - 1] = chunk.slice(end);
}

/** `textwrap.wrap(text, width)` with the module defaults. */
export function pyWrap(text: string, width: number): string[] {
  if (width <= 0) throw new Error(`invalid width ${width} (must be > 0)`);
  const chunks = text.split(_WORDSEP_RE).filter((chunk) => chunk);
  chunks.reverse();
  const lines: string[] = [];
  while (chunks.length) {
    const curLine: string[] = [];
    let curLen = 0;
    if (lines.length && _isBlank(chunks[chunks.length - 1] as string)) chunks.pop();
    while (chunks.length) {
      const length = (chunks[chunks.length - 1] as string).length;
      if (curLen + length <= width) {
        curLine.push(chunks.pop() as string);
        curLen += length;
      } else {
        break;
      }
    }
    if (chunks.length && (chunks[chunks.length - 1] as string).length > width) {
      _handleLongWord(chunks, curLine, curLen, width);
      curLen = curLine.reduce((total, part) => total + part.length, 0);
    }
    if (curLine.length && _isBlank(curLine[curLine.length - 1] as string)) {
      curLen -= (curLine[curLine.length - 1] as string).length;
      curLine.pop();
    }
    if (curLine.length) lines.push(curLine.join(""));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// argparse
// ---------------------------------------------------------------------------

/** `SystemExit`; `main` converts it into its own return code. */
export class SystemExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`SystemExit: ${code}`);
    this.name = "SystemExit";
    this.code = code;
  }
}

/** `argparse.ArgumentTypeError`. */
export class ArgumentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentTypeError";
  }
}

const _MAX_HELP_POSITION = 24;
const _INDENT_INCREMENT = 2;

/** `shutil.get_terminal_size().columns - 2`, the argparse formatter width. */
function _helpWidth(): number {
  const configured = process.env["COLUMNS"];
  if (configured && /^\d+$/.test(configured)) return Math.max(11, Number(configured) - 2);
  const columns = process.stdout.isTTY ? process.stdout.columns : 0;
  return Math.max(11, (columns || 80) - 2);
}

type ActionKind =
  | "store"
  | "store_true"
  | "append"
  | "help"
  | "version"
  | "boolean_optional"
  | "subparsers";

interface Action {
  optionStrings: string[];
  dest: string;
  kind: ActionKind;
  choices: readonly string[] | null;
  /** `argparse.Action.default`. */
  defaultValue: unknown;
  /** `null` stands for `argparse.SUPPRESS`. */
  help: string | null;
  required: boolean;
  metavar: string | null;
  type: ((value: string) => unknown) | null;
  version: string;
}

export type Namespace = Record<string, unknown>;

interface AddArgumentOptions {
  dest?: string;
  action?: "store" | "store_true" | "append" | "version" | "boolean_optional";
  choices?: readonly string[] | null;
  default?: unknown;
  help?: string | null;
  required?: boolean;
  metavar?: string | null;
  type?: ((value: string) => unknown) | null;
  version?: string;
}

function _takesValue(action: Action): boolean {
  return action.kind === "store" || action.kind === "append";
}

function _looksLikeOption(token: string | undefined): boolean {
  if (token === undefined) return false;
  if (token.length < 2 || !token.startsWith("-")) return false;
  return !/^-\d/.test(token);
}

export class ArgumentParser {
  readonly prog: string;
  readonly description: string;
  readonly epilog: string;
  readonly actions: Action[] = [];
  readonly subparsers = new Map<string, ArgumentParser>();
  readonly subparserHelps = new Map<string, string>();
  private subparsersAction: Action | null = null;

  constructor(options: {
    prog: string;
    description?: string;
    epilog?: string;
    addHelp?: boolean;
  }) {
    this.prog = options.prog;
    this.description = options.description ?? "";
    this.epilog = options.epilog ?? "";
    if (options.addHelp ?? true) {
      this.actions.push({
        optionStrings: ["-h", "--help"],
        dest: "help",
        kind: "help",
        choices: null,
        defaultValue: undefined,
        help: "show this help message and exit",
        required: false,
        metavar: null,
        type: null,
        version: "",
      });
    }
  }

  addArgument(names: string | readonly string[], options: AddArgumentOptions = {}): void {
    const optionStrings = (typeof names === "string" ? [names] : [...names]).filter((name) =>
      name.startsWith("-"),
    );
    const positionalName = typeof names === "string" ? names : (names[0] as string);
    const kind: ActionKind =
      options.action === "store_true"
        ? "store_true"
        : options.action === "append"
          ? "append"
          : options.action === "version"
            ? "version"
            : options.action === "boolean_optional"
              ? "boolean_optional"
              : "store";
    let dest = options.dest;
    if (!dest) {
      dest = optionStrings.length
        ? ((optionStrings.find((name) => name.startsWith("--")) ?? optionStrings[0]) as string)
            .replace(/^--?/, "")
            .replace(/-/g, "_")
        : positionalName;
    }
    const action: Action = {
      optionStrings:
        kind === "boolean_optional"
          ? [optionStrings[0] as string, `--no-${(optionStrings[0] as string).slice(2)}`]
          : optionStrings,
      dest,
      kind,
      choices: options.choices ?? null,
      defaultValue:
        options.default === undefined
          ? kind === "store_true"
            ? false
            : null
          : options.default,
      help: options.help === undefined ? null : options.help,
      required: options.required ?? optionStrings.length === 0,
      metavar: options.metavar ?? null,
      type: options.type ?? null,
      version: options.version ?? "",
    };
    this.actions.push(action);
  }

  addSubparsers(dest: string): void {
    this.subparsersAction = {
      optionStrings: [],
      dest,
      kind: "subparsers",
      choices: null,
      defaultValue: null,
      help: "",
      required: false,
      metavar: null,
      type: null,
      version: "",
    };
    this.actions.push(this.subparsersAction);
  }

  addParser(
    name: string,
    options: { help: string; epilog?: string },
  ): ArgumentParser {
    const parser = new ArgumentParser({
      prog: `${this.prog} ${name}`,
      epilog: options.epilog ?? "",
    });
    this.subparsers.set(name, parser);
    this.subparserHelps.set(name, options.help);
    return parser;
  }

  // --- formatting --------------------------------------------------------

  private _metavarFor(action: Action, defaultName: string): string {
    if (action.metavar !== null) return action.metavar;
    // A subparsers action carries its choices in the parser map, not in
    // `choices`; argparse still renders them as the metavar.
    if (action.kind === "subparsers") return `{${[...this.subparsers.keys()].join(",")}}`;
    if (action.choices) return `{${action.choices.join(",")}}`;
    return defaultName;
  }

  private _formatArgs(action: Action, defaultName: string): string {
    const metavar = this._metavarFor(action, defaultName);
    if (action.kind === "subparsers") return `${metavar} ...`;
    return metavar;
  }

  private _formatInvocation(action: Action): string {
    // Positionals show only their metavar here; the `...` suffix belongs to the
    // usage line, which goes through `_formatArgs` instead.
    if (action.optionStrings.length === 0) return this._metavarFor(action, action.dest);
    if (!_takesValue(action)) return action.optionStrings.join(", ");
    return `${action.optionStrings.join(", ")} ${this._formatArgs(action, action.dest.toUpperCase())}`;
  }

  /** `_HelpFormatter._get_help_string`: suppress the auto-appended default. */
  private _expandHelp(action: Action): string {
    const help = action.help ?? "";
    const value = action.defaultValue;
    if (value === null || value === undefined) return help;
    if (Array.isArray(value) && value.length === 0) return help;
    if (!_takesValue(action)) return help;
    return `${help} (default: ${_pyRepr(value)})`;
  }

  private _usageParts(): [string[], string[]] {
    const optParts: string[] = [];
    const posParts: string[] = [];
    for (const action of this.actions) {
      if (action.help === null) continue;
      if (action.optionStrings.length === 0) {
        posParts.push(this._formatArgs(action, action.dest));
        continue;
      }
      let part: string;
      if (action.kind === "boolean_optional") {
        part = action.optionStrings.join(" | ");
      } else if (!_takesValue(action)) {
        part = action.optionStrings[0] as string;
      } else {
        part = `${action.optionStrings[0]} ${this._formatArgs(action, action.dest.toUpperCase())}`;
      }
      if (!action.required) part = `[${part}]`;
      optParts.push(part);
    }
    return [optParts, posParts];
  }

  private _formatUsageBody(): string {
    const prefix = "usage: ";
    const prog = this.prog;
    const [optParts, posParts] = this._usageParts();
    const flat = [prog, ...optParts, ...posParts].join(" ");
    const textWidth = _helpWidth();
    if (prefix.length + flat.length <= textWidth) return flat;

    const getLines = (parts: string[], indent: string, withPrefix: boolean): string[] => {
      const lines: string[] = [];
      let line: string[] = [];
      let lineLen = (withPrefix ? prefix.length : indent.length) - 1;
      for (const part of parts) {
        if (lineLen + 1 + part.length > textWidth && line.length) {
          lines.push(indent + line.join(" "));
          line = [];
          lineLen = indent.length - 1;
        }
        line.push(part);
        lineLen += 1 + part.length;
      }
      if (line.length) lines.push(indent + line.join(" "));
      if (withPrefix && lines.length) lines[0] = (lines[0] as string).slice(indent.length);
      return lines;
    };

    let lines: string[];
    if (prefix.length + prog.length <= 0.75 * textWidth) {
      const indent = " ".repeat(prefix.length + prog.length + 1);
      if (optParts.length) {
        lines = getLines([prog, ...optParts], indent, true);
        lines.push(...getLines(posParts, indent, false));
      } else if (posParts.length) {
        lines = getLines([prog, ...posParts], indent, true);
      } else {
        lines = [prog];
      }
    } else {
      const indent = " ".repeat(prefix.length);
      lines = getLines([...optParts, ...posParts], indent, false);
      if (lines.length > 1) {
        lines = [...getLines(optParts, indent, false), ...getLines(posParts, indent, false)];
      }
      lines = [prog, ...lines];
    }
    return lines.join("\n");
  }

  formatUsage(): string {
    return `usage: ${this._formatUsageBody()}\n`;
  }

  formatHelp(): string {
    const width = _helpWidth();
    const visible = this.actions.filter((action) => action.help !== null);
    const positionals = visible.filter((action) => action.optionStrings.length === 0);
    const optionals = visible.filter((action) => action.optionStrings.length > 0);

    let actionMaxLength = 0;
    for (const action of visible) {
      const invocations = [this._formatInvocation(action)];
      if (action.kind === "subparsers") invocations.push(...this.subparsers.keys());
      const longest = invocations.reduce((best, text) => Math.max(best, text.length), 0);
      actionMaxLength = Math.max(actionMaxLength, longest + _INDENT_INCREMENT);
    }
    const helpPosition = Math.min(actionMaxLength + 2, _MAX_HELP_POSITION);
    const helpTextWidth = Math.max(width - helpPosition, 11);

    const formatOne = (header: string, help: string, currentIndent: number): string => {
      const actionWidth = helpPosition - currentIndent - 2;
      const parts: string[] = [];
      let indentFirst = 0;
      if (!help) {
        parts.push(`${" ".repeat(currentIndent)}${header}\n`);
      } else if (header.length <= actionWidth) {
        parts.push(`${" ".repeat(currentIndent)}${header.padEnd(actionWidth)}  `);
      } else {
        parts.push(`${" ".repeat(currentIndent)}${header}\n`);
        indentFirst = helpPosition;
      }
      if (help && help.trim()) {
        const helpLines = pyWrap(help.replace(/\s+/g, " ").trim(), helpTextWidth);
        parts.push(`${" ".repeat(indentFirst)}${helpLines[0] ?? ""}\n`);
        for (const line of helpLines.slice(1)) {
          parts.push(`${" ".repeat(helpPosition)}${line}\n`);
        }
      } else if (!(parts[parts.length - 1] as string).endsWith("\n")) {
        parts.push("\n");
      }
      return parts.join("");
    };

    const formatAction = (action: Action, currentIndent: number): string => {
      let text = formatOne(this._formatInvocation(action), this._expandHelp(action), currentIndent);
      if (action.kind === "subparsers") {
        for (const [name, help] of this.subparserHelps) {
          text += formatOne(name, help, currentIndent + _INDENT_INCREMENT);
        }
      }
      return text;
    };

    let out = `usage: ${this._formatUsageBody()}\n\n`;
    if (this.description) out += `${this.description}\n\n`;
    if (positionals.length) {
      out += `\npositional arguments:\n${positionals.map((a) => formatAction(a, 2)).join("")}\n`;
    }
    if (optionals.length) {
      out += `\noptions:\n${optionals.map((a) => formatAction(a, 2)).join("")}\n`;
    }
    if (this.epilog) out += `\n${this.epilog}\n\n`;
    out = out.replace(/\n\n\n+/g, "\n\n");
    return `${out.replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
  }

  printHelp(): void {
    process.stdout.write(this.formatHelp());
  }

  printUsage(toStderr = false): void {
    const text = this.formatUsage();
    if (toStderr) process.stderr.write(text);
    else process.stdout.write(text);
  }

  error(message: string): never {
    this.printUsage(true);
    eprint(`${this.prog}: error: ${message}`);
    throw new SystemExit(2);
  }

  // --- parsing -----------------------------------------------------------

  private _actionName(action: Action): string {
    if (action.optionStrings.length) return action.optionStrings.join("/");
    if (action.metavar !== null) return action.metavar;
    return action.dest;
  }

  private _matchOption(name: string): Action | null {
    for (const action of this.actions) {
      if (action.optionStrings.includes(name)) return action;
    }
    if (!name.startsWith("--")) return null;
    const candidates: [Action, string][] = [];
    for (const action of this.actions) {
      for (const option of action.optionStrings) {
        if (option.startsWith(name)) candidates.push([action, option]);
      }
    }
    if (candidates.length === 1) return (candidates[0] as [Action, string])[0];
    if (candidates.length > 1) {
      this.error(
        `ambiguous option: ${name} could match ${candidates.map(([, option]) => option).join(", ")}`,
      );
    }
    return null;
  }

  private _checkChoices(action: Action, value: string): void {
    if (!action.choices) return;
    if (action.choices.includes(value)) return;
    this.error(
      `argument ${this._actionName(action)}: invalid choice: '${value}' ` +
        `(choose from ${action.choices.join(", ")})`,
    );
  }

  private _convert(action: Action, value: string): unknown {
    if (action.type === null) return value;
    try {
      return action.type(value);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      this.error(`argument ${this._actionName(action)}: ${message}`);
    }
  }

  parseKnownArgs(argv: readonly string[], namespace?: Namespace): [Namespace, string[]] {
    const ns: Namespace = namespace ?? {};
    for (const action of this.actions) {
      if (action.kind === "help" || action.kind === "version") continue;
      if (!(action.dest in ns)) ns[action.dest] = action.defaultValue;
    }
    const extras: string[] = [];
    const positionals = this.actions.filter((action) => action.optionStrings.length === 0);
    let positionalIndex = 0;
    let onlyPositionals = false;
    let index = 0;
    while (index < argv.length) {
      const token = argv[index] as string;
      index += 1;
      if (!onlyPositionals && token === "--") {
        onlyPositionals = true;
        continue;
      }
      if (!onlyPositionals && _looksLikeOption(token)) {
        let name = token;
        let attached: string | null = null;
        const equals = token.indexOf("=");
        if (token.startsWith("--") && equals > 0) {
          name = token.slice(0, equals);
          attached = token.slice(equals + 1);
        }
        const action = this._matchOption(name);
        if (action === null) {
          extras.push(token);
          continue;
        }
        if (action.kind === "help") {
          this.printHelp();
          throw new SystemExit(0);
        }
        if (action.kind === "version") {
          print(action.version);
          throw new SystemExit(0);
        }
        if (action.kind === "store_true") {
          if (attached !== null) {
            this.error(`argument ${this._actionName(action)}: ignored explicit argument '${attached}'`);
          }
          ns[action.dest] = true;
          continue;
        }
        if (action.kind === "boolean_optional") {
          if (attached !== null) {
            this.error(`argument ${this._actionName(action)}: ignored explicit argument '${attached}'`);
          }
          ns[action.dest] = !name.startsWith("--no-");
          continue;
        }
        let value: string;
        if (attached !== null) {
          value = attached;
        } else if (index < argv.length && !_looksLikeOption(argv[index])) {
          value = argv[index] as string;
          index += 1;
        } else {
          this.error(`argument ${this._actionName(action)}: expected one argument`);
        }
        this._checkChoices(action, value);
        const converted = this._convert(action, value);
        if (action.kind === "append") {
          const current = ns[action.dest];
          const list = Array.isArray(current) ? (current as unknown[]) : [];
          list.push(converted);
          ns[action.dest] = list;
        } else {
          ns[action.dest] = converted;
        }
        continue;
      }
      const action = positionals[positionalIndex];
      if (action === undefined) {
        extras.push(token);
        continue;
      }
      positionalIndex += 1;
      if (action.kind === "subparsers") {
        const sub = this.subparsers.get(token);
        if (sub === undefined) {
          this.error(
            `argument ${action.dest}: invalid choice: '${token}' ` +
              `(choose from ${[...this.subparsers.keys()].join(", ")})`,
          );
        }
        ns[action.dest] = token;
        const rest = argv.slice(index);
        index = argv.length;
        const [, subExtras] = sub.parseKnownArgs(rest, ns);
        extras.push(...subExtras);
        continue;
      }
      this._checkChoices(action, token);
      ns[action.dest] = this._convert(action, token);
    }

    const missing: string[] = [];
    for (const action of this.actions) {
      if (action.kind === "help" || action.kind === "version") continue;
      if (action.kind === "subparsers") continue;
      if (!action.required) continue;
      const value = ns[action.dest];
      if (value === null || value === undefined) missing.push(this._actionName(action));
    }
    if (missing.length) {
      this.error(`the following arguments are required: ${missing.join(", ")}`);
    }
    return [ns, extras];
  }

  parseArgs(argv: readonly string[]): Namespace {
    const [ns, extras] = this.parseKnownArgs(argv);
    if (extras.length) this.error(`unrecognized arguments: ${extras.join(" ")}`);
    return ns;
  }
}

/** `str(value)` for the `(default: …)` suffix. */
function _pyRepr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

// ---------------------------------------------------------------------------
// --- cli.py ---
// ---------------------------------------------------------------------------

function _flag(prefix: string, suffix: string): string {
  return `--${prefix.replace(/_/g, "-")}-${suffix}`;
}

function _positiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^[+-]?\d+$/.test(value.trim()) || !Number.isFinite(parsed)) {
    throw new ArgumentTypeError("must be an integer");
  }
  if (parsed < 1) throw new ArgumentTypeError("must be at least 1");
  // Only the run-count option uses this helper with a dedicated wrapper
  // below; episode timeout values remain positive without inheriting a
  // surprisingly small round ceiling.
  return parsed;
}

function _maxRounds(value: string): number {
  const parsed = _positiveInt(value);
  if (parsed > MAX_ROUNDS) throw new ArgumentTypeError(`must be at most ${MAX_ROUNDS}`);
  return parsed;
}

function _port(value: string): number {
  const parsed = Number(value);
  if (!/^[+-]?\d+$/.test(value.trim()) || !Number.isFinite(parsed)) {
    throw new ArgumentTypeError(`invalid int value: '${value}'`);
  }
  if (!(parsed >= 0 && parsed <= 65535)) {
    throw new ArgumentTypeError("must be between 0 and 65535");
  }
  return parsed;
}

function _reasoningEffort(value: string): string {
  // Python imports the registry inside this function so `--help` needs no
  // registry import; `config.ts` already imports it statically here, so the
  // validation itself is all that is left to mirror.
  try {
    return normaliseReasoningEffort(value);
  } catch (exc) {
    throw new ArgumentTypeError(_text(exc));
  }
}

// --- path helpers ----------------------------------------------------------

/** `Path(...).expanduser().resolve()` with `strict=False`. */
function _resolvePath(target: string): string {
  const absolute = path.resolve(expandUser(target));
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** `Path.is_relative_to`. */
function _isRelativeTo(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function _relativeParts(child: string, parent: string): string[] {
  const relative = path.relative(parent, child);
  return relative ? relative.split(path.sep) : [];
}

function _errno(exc: unknown): string {
  return typeof exc === "object" && exc !== null
    ? String((exc as NodeJS.ErrnoException).code ?? "")
    : "";
}

function _text(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// --- run directory reservation ---------------------------------------------

/** Reserve an isolated run directory without ever reusing old state. */
export function reserveRunDir(
  runsRoot: string,
  requestedRunId: string | null,
): [string, string] {
  const root = _resolvePath(runsRoot);
  fs.mkdirSync(root, { recursive: true });
  const explicit = requestedRunId !== null && requestedRunId !== undefined;
  const candidate = pyStrip(String(requestedRunId ?? ""));
  if (
    explicit &&
    (!candidate ||
      candidate === "." ||
      candidate === ".." ||
      candidate.includes("/") ||
      candidate.includes("\\") ||
      candidate.includes("\u0000"))
  ) {
    throw new Error("run id must be a non-empty single path component");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = explicit ? candidate : `${_utcStamp()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const runDir = path.join(root, runId);
    try {
      const resolved = _resolvePath(runDir);
      if (!_isRelativeTo(resolved, root)) throw new Error("outside");
    } catch {
      throw new Error("run id resolves outside the configured runs root");
    }
    try {
      fs.mkdirSync(runDir);
    } catch (exc) {
      if (_errno(exc) === "EEXIST") {
        if (explicit) throw new Error(`run already exists: ${runId}`);
        continue;
      }
      throw exc;
    }
    return [runId, runDir];
  }
  throw new Error("could not reserve a unique run id");
}

/** `time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())`. */
function _utcStamp(): string {
  const now = new Date();
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

/** Read supervisor-owned metadata without following any path symlink. */
function _readSupervisedRecord(
  target: string,
  messages: { unavailable: string; invalid: string; tooLarge: string },
): Record<string, unknown> {
  const limit = 256 * 1024;
  let fd: number | null = null;
  let value: unknown;
  try {
    fd = _openNofollow(target);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(messages.invalid);
    if (metadata.size > limit) throw new Error(messages.tooLarge);
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, total, Math.min(64 * 1024, limit + 1 - total), null);
      if (read <= 0) break;
      total += read;
      if (total >= limit + 1) break;
    }
    if (total > limit) throw new Error(messages.tooLarge);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)));
  } catch (exc) {
    if (_errno(exc) === "ENOENT") throw new Error(messages.unavailable);
    if (exc instanceof Error && (exc.message === messages.tooLarge || exc.message === messages.invalid)) {
      throw exc;
    }
    throw new Error(messages.invalid);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(messages.invalid);
  }
  return value as Record<string, unknown>;
}

/**
 * Take over the reservation created by `RunSupervisor`.
 *
 * The supervisor deliberately creates the run directory and writes an owner
 * reservation *before* spawning the worker. A normal CLI reservation would
 * therefore reject the worker with `run already exists`. `--supervised` is an
 * internal capability, so it may only adopt a directory whose durable owner
 * record proves that this exact child process was reserved for this request.
 */
export function adoptSupervisedRunDir(
  runsRoot: string,
  requestedRunId: string | null,
  options: {
    task: string | null;
    agent: string;
    model: string | null;
    workspace: string | null;
    maxRounds: number;
    roleConfigs?: Record<string, Record<string, string>> | null;
  },
): [string, string] {
  const root = _resolvePath(runsRoot);
  if (requestedRunId === null || requestedRunId === undefined) {
    throw new Error("supervised runs require an explicit run id");
  }
  const candidate = pyStrip(String(requestedRunId));
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.includes("\u0000")
  ) {
    throw new Error("run id must be a non-empty single path component");
  }
  const runDir = path.join(root, candidate);
  try {
    const resolved = _resolvePath(runDir);
    if (!_isRelativeTo(resolved, root)) throw new Error("outside");
  } catch {
    throw new Error("run id resolves outside the configured runs root");
  }
  let stats: fs.Stats | null = null;
  try {
    const link = fs.lstatSync(runDir);
    if (link.isSymbolicLink()) throw new Error("symlink");
    stats = fs.statSync(runDir);
  } catch {
    stats = null;
  }
  if (stats === null || !stats.isDirectory()) {
    throw new Error("supervised run reservation is missing");
  }

  const messages = {
    unavailable: "supervised run reservation is incomplete",
    invalid: "supervised run reservation is invalid",
    tooLarge: "supervised reservation metadata is too large",
  };
  const owner = _readSupervisedRecord(path.join(runDir, "control", "owner.json"), messages);
  const status = _readSupervisedRecord(path.join(runDir, "control", "status.json"), messages);
  if (String(owner["run_id"] ?? "") !== candidate) {
    throw new Error("supervised run reservation has the wrong run id");
  }
  // The owner PID is assigned before spawn. Requiring the current process
  // identity closes the obvious arbitrary-adoption hole while still matching
  // the supervisor's child exactly.
  const ownerPid = _asInt(owner["pid"], () => {
    throw new Error("supervised run reservation has an invalid owner pid");
  });
  if (ownerPid !== 0 && ownerPid !== process.pid) {
    throw new Error("supervised run reservation belongs to another process");
  }
  if (ownerPid === 0) {
    // There is a small, legitimate window between spawn returning and the
    // supervisor promoting the reservation with the child PID. Bind that window
    // to the recorded parent supervisor, never to an arbitrary caller that
    // happens to know the run id.
    const reservationParent = _asInt(owner["supervisor_pid"], () => {
      throw new Error("supervised run reservation has an invalid parent pid");
    });
    if (reservationParent <= 0 || reservationParent !== cliHooks.getppid()) {
      throw new Error("supervised run reservation is not owned by this worker");
    }
  }
  if (String(status["run_id"] ?? candidate) !== candidate) {
    throw new Error("supervised run status has the wrong run id");
  }
  const lifecycle = pyStrip(String(status["status"] ?? owner["state"] ?? "")).toLowerCase();
  if (
    ["completed", "complete", "failed", "cancelled", "canceled", "blocked", "incomplete"].includes(
      lifecycle,
    )
  ) {
    throw new Error("supervised run reservation is already terminal");
  }

  const expectedTask = pyStrip(String(owner["task"] ?? ""));
  const task = options.task;
  if (task !== null && expectedTask && expectedTask !== pyStrip(task)) {
    throw new Error("supervised run task does not match its reservation");
  }
  if (String(owner["agent"] ?? options.agent) !== options.agent) {
    throw new Error("supervised run agent does not match its reservation");
  }
  const expectedModelRaw = owner["model"];
  const expectedModel =
    expectedModelRaw === null || expectedModelRaw === undefined
      ? null
      : pyStrip(String(expectedModelRaw));
  const suppliedModel = typeof options.model === "string" ? pyStrip(options.model) : options.model ?? null;
  if (expectedModel !== suppliedModel) {
    throw new Error("supervised run model does not match its reservation");
  }
  const expectedRolesRaw = owner["role_configs"];
  const expectedRoles =
    typeof expectedRolesRaw === "object" &&
    expectedRolesRaw !== null &&
    !Array.isArray(expectedRolesRaw) &&
    Object.keys(expectedRolesRaw as object).length
      ? (expectedRolesRaw as Record<string, unknown>)
      : null;
  const suppliedRoles = options.roleConfigs ?? null;
  // Python compares the two dicts by value; the reservation is written with
  // sorted keys while the worker rebuilds its map in role order, so compare a
  // canonical (sorted-key) serialisation, never the raw insertion order.
  if (jsonDumpsSorted(expectedRoles) !== jsonDumpsSorted(suppliedRoles)) {
    throw new Error("supervised run role configuration does not match its reservation");
  }
  const reservedRounds =
    owner["max_rounds"] === undefined
      ? options.maxRounds
      : _asInt(owner["max_rounds"], () => {
          throw new Error("supervised run reservation has invalid max_rounds");
        });
  if (reservedRounds !== options.maxRounds) {
    throw new Error("supervised run max_rounds does not match its reservation");
  }
  if (options.workspace !== null && options.workspace !== undefined && owner["workspace"]) {
    let requestedWorkspace: string;
    let reservedWorkspace: string;
    try {
      requestedWorkspace = _resolvePath(options.workspace);
      reservedWorkspace = _resolvePath(String(owner["workspace"]));
    } catch {
      throw new Error("supervised run workspace is invalid");
    }
    if (requestedWorkspace !== reservedWorkspace) {
      throw new Error("supervised run workspace does not match its reservation");
    }
  }
  return [candidate, runDir];
}

function _asInt(value: unknown, onError: () => never): number {
  if (value === null || value === undefined || value === "" || value === false) return 0;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) onError();
  return parsed;
}

/** Claim the pre-spawn reservation as soon as the worker starts. */
export async function claimSupervisedOwner(runId: string, runDir: string): Promise<void> {
  const ownerPath = path.join(runDir, "control", "owner.json");
  const value = _readSupervisedRecord(ownerPath, {
    unavailable: "supervised run owner metadata is unavailable",
    invalid: "supervised run owner metadata is unavailable",
    tooLarge: "supervised run owner metadata is too large",
  });
  if (String(value["run_id"] ?? "") !== runId) {
    throw new Error("supervised run owner metadata is invalid");
  }
  const existingPid = _asInt(value["pid"], () => {
    throw new Error("supervised run owner pid is invalid");
  });
  if (existingPid !== 0 && existingPid !== process.pid) {
    throw new Error("supervised run owner belongs to another process");
  }
  if (existingPid === process.pid) return;
  const parentPid = _asInt(value["supervisor_pid"], () => {
    throw new Error("supervised run parent pid is invalid");
  });
  if (parentPid !== cliHooks.getppid()) {
    throw new Error("supervised run parent does not match its reservation");
  }
  const { ControlBus } = await import("./supervisor/control_bus.js");
  new ControlBus(runDir).writeOwner({
    ...value,
    state: "running",
    pid: process.pid,
    pgid: process.pid,
    signal_mode: "pgid",
  });
}

function _fallbackHint(role: string, suffix: string): string {
  const parent = _ROLE_PARENTS[role] ?? null;
  const chain = (parent ? [_flag(parent, suffix)] : []).concat([`--${suffix}`]);
  return chain.join(", then ");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Seams the test-suite replaces (`monkeypatch.setattr(cli, …)` in Python). */
export const cliHooks: {
  loadRunDefaults: () => Record<string, unknown>;
  runCommand: (args: Namespace) => Promise<number>;
  getppid: () => number;
} = {
  loadRunDefaults: () => loadRunDefaults(),
  runCommand: (args: Namespace) => _runCommand(args),
  getppid: () => process.ppid,
};

export function buildParser(runDefaults: Record<string, unknown>): {
  parser: ArgumentParser;
  pluginParser: ArgumentParser;
} {
  const runDefault = (name: string, fallback: unknown = null): unknown =>
    name in runDefaults ? runDefaults[name] : fallback;

  const parser = new ArgumentParser({
    prog: "lh-harness",
    description: `LongHorizon-Harness ${VERSION}`,
    epilog: _EPILOG,
  });
  parser.addArgument(["-V", "--version"], {
    action: "version",
    version: `lh-harness ${VERSION}`,
    help: "show program's version number and exit",
  });
  parser.addSubparsers("command");

  const addCommand = (name: string, helpText: string): ArgumentParser =>
    // Every subcommand repeats the homepage/issues epilog so the links show
    // up no matter which --help the user reaches for.
    parser.addParser(name, { help: helpText, epilog: _EPILOG });

  const runParser = addCommand(
    "run",
    "Run a long-horizon task through role-managed LongHorizon-Harness",
  );
  runParser.addArgument("--task", { required: true, help: "Task text or @path" });
  runParser.addArgument("--agent", {
    default: runDefault("agent", "claude_code"),
    choices: _AGENT_CHOICES,
    help: "Agent implementation for every role.",
  });
  runParser.addArgument("--model", {
    default: runDefault("model"),
    help: "Model for every role. Defaults to the chosen agent's own default.",
  });
  runParser.addArgument("--reasoning-effort", {
    default: runDefault("reasoning_effort"),
    type: _reasoningEffort,
    help:
      "Reasoning effort for every role, passed through to the agent that " +
      "supports it. Defaults to the provider's own setting.",
  });
  for (const [role, , scope] of _ROLE_OPTIONS) {
    runParser.addArgument(_flag(role, "agent"), {
      default: runDefault(`${role}_agent`),
      choices: _AGENT_CHOICES,
      help: `Agent implementation for ${scope}; defaults to ${_fallbackHint(role, "agent")}.`,
    });
    runParser.addArgument(_flag(role, "model"), {
      default: runDefault(`${role}_model`),
      help: `Model for ${scope}; defaults to ${_fallbackHint(role, "model")}.`,
    });
    runParser.addArgument(_flag(role, "reasoning-effort"), {
      dest: `${role}_reasoning_effort`,
      default: runDefault(`${role}_reasoning_effort`),
      type: _reasoningEffort,
      help: `Reasoning effort for ${scope}; defaults to ${_fallbackHint(role, "reasoning-effort")}.`,
    });
  }
  // Only the local backend is implemented; kept as a flag so existing
  // `--env local` invocations keep working and future backends can slot in.
  runParser.addArgument("--env", {
    default: runDefault("env", "local"),
    choices: ["local"],
    help: "Environment the agent runs in.",
  });
  runParser.addArgument("--runs-root", {
    default: runDefault("runs_root", _DEFAULT_RUNS_ROOT),
    help: "Base directory holding one isolated subfolder per run.",
  });
  runParser.addArgument("--run-id", {
    default: null,
    help:
      "Unique id for this run. Defaults to a timestamp + short uuid. " +
      "All run data goes under <runs-root>/<run-id>/.",
  });
  runParser.addArgument("--workspace", {
    default: runDefault("workspace"),
    help:
      "Override the working directory the agents operate in. " +
      "Defaults to the directory lh-harness was started from.",
  });
  runParser.addArgument("--harness-dir", {
    default: runDefault("harness_dir"),
    help: "Override the harness state directory. Defaults to <runs-root>/<run-id>/harness.",
  });
  runParser.addArgument("--log-dir", {
    default: runDefault("log_dir"),
    help: "Override the log directory. Defaults to <runs-root>/<run-id>/lh_harness.",
  });
  // Credentials are handed to the agent CLI as its own env vars; the adapter
  // maps them to its backend (ANTHROPIC_* for claude_code).
  runParser.addArgument("--api-key", {
    help: "LLM API key for the agent CLI. Omit to reuse its existing login or environment.",
  });
  runParser.addArgument("--base-url", {
    default: runDefault("base_url"),
    help: "Provider endpoint for the agent CLI. The trailing `/v1` is normalized when required by the backend.",
  });
  runParser.addArgument("--prompt-language", {
    choices: ["en", "zh"],
    default: runDefault("prompt_language", "en"),
    help: "Language for manager/executor/auditor prompts.",
  });
  // One entry per agent, each in that agent's own format: no translation.
  runParser.addArgument("--claude-mcp-config", {
    default: runDefault("claude_mcp_config"),
    help:
      "MCP config for Claude Code, in its own `.mcp.json` format. Overrides the installed " +
      "computer-use plugin, which is loaded automatically otherwise.",
  });
  runParser.addArgument("--codex-mcp-config", {
    default: runDefault("codex_mcp_config"),
    help:
      "MCP config for Codex, a TOML file holding `[mcp_servers.<name>]` tables. Overrides " +
      "the installed computer-use plugin, which is loaded automatically otherwise.",
  });
  runParser.addArgument("--mcp-add-dir", {
    action: "append",
    default: null,
    help: "Extra directory to expose to the agent. May be repeated.",
  });
  runParser.addArgument("--guard-exclude-path", {
    action: "append",
    // Repeatable options must default to None and be filled in after parsing
    // (see applyRepeatableDefaults): argparse appends to whatever default it is
    // given, so a project-config list would be extended by the command line
    // instead of replaced by it.
    default: null,
    help:
      "Volatile workspace path the auditor read-only guard skips while " +
      "snapshotting (build outputs and similar churn). Relative paths " +
      "resolve against the workspace; agents may still read them. " +
      "Replaces run.guard_exclude_paths from the project config. " +
      "May be repeated.",
  });
  runParser.addArgument("--max-rounds", {
    type: _maxRounds,
    default: runDefault("max_rounds"),
    help: `Maximum number of manage-execute-audit rounds (1-${MAX_ROUNDS}). If omitted, uses ${_DEFAULT_MAX_ROUNDS}.`,
  });
  for (const [role, timeout] of _BUDGET_OPTIONS) {
    const scope = _ROLE_SCOPES[role] as string;
    runParser.addArgument(_flag(role, "timeout"), {
      type: _positiveInt,
      default: runDefault(`${role}_timeout`, timeout),
      help: `Per-episode timeout in seconds for ${scope}.`,
    });
  }
  runParser.addArgument("--dashboard", {
    action: "boolean_optional",
    default: runDefault("dashboard", true),
    help: "Launch the web dashboard in the background for live monitoring and human approval.",
  });
  runParser.addArgument("--dashboard-port", {
    type: _port,
    default: runDefault("dashboard_port", 0),
    help: "Dashboard port; 0 lets the OS pick a free one.",
  });
  runParser.addArgument("--dashboard-host", {
    default: "127.0.0.1",
    help: "Dashboard bind host (default: 127.0.0.1).",
  });
  runParser.addArgument("--dashboard-no-open", {
    action: "store_true",
    help: "Do not open the dashboard URL in a browser.",
  });
  runParser.addArgument("--dashboard-auth-token", {
    default: process.env["LH_HARNESS_WEB_TOKEN"] ?? null,
    help: "Bearer token when binding the live dashboard beyond localhost.",
  });
  runParser.addArgument("--keep-dashboard", {
    action: "store_true",
    help: "Keep the dashboard alive after any run; Dashboard Stop/Abort already keeps it alive.",
  });
  runParser.addArgument("--supervised", { action: "store_true" });
  runParser.addArgument("--resume", { action: "store_true" });

  const dashParser = addCommand("dashboard", "Serve the Web workbench");
  dashParser.addArgument("--runs-root", {
    default: _DEFAULT_RUNS_ROOT,
    help: "Base directory holding runs; the UI lists all runs and lets you switch between them.",
  });
  dashParser.addArgument("--log-dir", {
    default: null,
    help: "Pin one run's log directory instead of browsing --runs-root.",
  });
  dashParser.addArgument("--workspace-root", {
    default: ".",
    help: "Default workspace for runs created from the Web workbench (default: current directory).",
  });
  dashParser.addArgument("--host", { default: "127.0.0.1", help: "Bind host (default: 127.0.0.1)." });
  dashParser.addArgument("--port", {
    type: _port,
    default: 8799,
    help: "Dashboard port; 0 lets the OS pick a free one.",
  });
  dashParser.addArgument("--no-open", {
    action: "store_true",
    help: "Do not open the dashboard URL in a browser.",
  });
  dashParser.addArgument("--auth-token", {
    default: process.env["LH_HARNESS_WEB_TOKEN"] ?? null,
    help: "Bearer token for remote dashboard/API access (also LH_HARNESS_WEB_TOKEN).",
  });

  const webParser = addCommand("web", "Serve the FastAPI Web control API");
  webParser.addArgument("--runs-root", {
    default: _DEFAULT_RUNS_ROOT,
    help: "Base directory holding runs.",
  });
  webParser.addArgument("--workspace-root", {
    default: ".",
    help: "Default workspace for runs created from the Web workbench (default: current directory).",
  });
  webParser.addArgument("--log-dir", {
    default: null,
    help: "Pin one run's log directory instead of browsing runs.",
  });
  webParser.addArgument("--host", { default: "127.0.0.1", help: "Bind host (default: 127.0.0.1)." });
  webParser.addArgument("--port", {
    type: _port,
    default: 8799,
    help: "API port; 0 lets the OS pick a free one.",
  });
  webParser.addArgument("--no-open", {
    action: "store_true",
    help: "Do not open the API URL in a browser.",
  });
  webParser.addArgument("--auth-token", {
    default: process.env["LH_HARNESS_WEB_TOKEN"] ?? null,
    help: "Bearer token for remote/API access (also LH_HARNESS_WEB_TOKEN).",
  });

  addCommand("doctor", "Check the local environment and report computer-use plugin state");

  const pluginParser = addCommand("plugin", "Install or remove computer-use plugins");
  pluginParser.addSubparsers("plugin_command");
  for (const [action, helpText] of [
    ["list", "Show the available computer-use plugins and their install state"],
    ["install", "Install a computer-use plugin and register it with an agent"],
    ["uninstall", "Remove a computer-use plugin"],
  ] as const) {
    const subParser = pluginParser.addParser(action, { help: helpText, epilog: _EPILOG });
    if (action === "list") continue;
    subParser.addArgument("name", {
      choices: _PLUGIN_CHOICES,
      help: "Plugin to set up. Run `lh-harness plugin list` for what each one provides.",
    });
    if (action === "install") {
      subParser.addArgument("--agent", {
        action: "append",
        choices: _MCP_AGENT_CHOICES,
        default: null,
        help: "Agent to register the plugin with. May be repeated; defaults to every supported agent.",
      });
      subParser.addArgument("--no-activate", {
        action: "store_true",
        help: "Skip the plugin's consent and OS-permission commands (they need a desktop session).",
      });
    }
  }

  const initParser = addCommand("init", "Generate ./.lh-harness/config.toml for this project");
  initParser.addArgument("--force", {
    action: "store_true",
    help: "Replace an existing project configuration file.",
  });

  addCommand("check-update", "Check npm for a newer LongHorizon-Harness release");

  const startParser = addCommand(
    "start",
    "Initialize this folder (if needed) and serve the workbench for it",
  );
  startParser.addArgument("--docker", {
    action: "store_true",
    help: "Run the whole stack in a sandboxed container; this folder is bind-mounted, so all state stays on the host and survives restarts.",
  });
  startParser.addArgument("--port", {
    type: _port,
    default: 8799,
    help: "Workbench port on 127.0.0.1.",
  });
  startParser.addArgument("--no-open", {
    action: "store_true",
    help: "Do not open the workbench URL in a browser.",
  });

  return { parser, pluginParser };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await _main([...argv]);
  } catch (exc) {
    if (exc instanceof SystemExit) return exc.code;
    throw exc;
  }
}

async function _main(rawArgv: string[]): Promise<number> {
  let runDefaults: Record<string, unknown> = {};
  let configError: ProjectConfigError | null = null;
  if (rawArgv.length && rawArgv[0] === "run") {
    try {
      runDefaults = cliHooks.loadRunDefaults();
    } catch (exc) {
      if (exc instanceof ProjectConfigError) configError = exc;
      else throw exc;
    }
  }

  const { parser, pluginParser } = buildParser(runDefaults);
  const args = parser.parseArgs(rawArgv);
  const command = args["command"];
  if (command === "run") {
    if (configError !== null) parser.error(configError.message);
    applyRepeatableDefaults(args, runDefaults);
    if (_isFile(PROJECT_CONFIG_PATH)) {
      print(`Using config: ${path.resolve(PROJECT_CONFIG_PATH)}`);
    }
    return await cliHooks.runCommand(args);
  }
  if (command === "dashboard") return await _dashboardCommand(args);
  if (command === "web") return await _webCommand(args);
  if (command === "doctor") return await _doctorCommand();
  if (command === "plugin") {
    if (!args["plugin_command"]) {
      pluginParser.printHelp();
      return 2;
    }
    return await _pluginCommand(args);
  }
  if (command === "init") return _initCommand(args);
  if (command === "check-update") return await _checkUpdateCommand();
  if (command === "start") return await _startCommand(args);

  parser.printHelp();
  return 2;
}

function _isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const _MIN_NODE_MAJOR_RUNTIME = 22;
const _MIN_NODE_MAJOR = 20;

export function doctorLine(status: string, label: string, detail: string): void {
  print(`[${status.padEnd(4)}] ${label}: ${detail}`);
}

async function _doctorCommand(): Promise<number> {
  const { startUpdateCheck } = await import("./utils/update_check.js");

  const updateCheck = startUpdateCheck(VERSION);
  print(`LongHorizon-Harness doctor (${VERSION})`);
  print(`Platform: ${os.type()}-${os.release()}-${os.arch()}`);
  print(`Homepage: ${HOMEPAGE}`);
  print(`Issues:   ${ISSUES_URL}`);

  let failures = 0;
  let warnings = 0;
  // The Python original checks its own interpreter version here; the Node
  // runtime is this port's equivalent hard requirement.
  const nodeMajor = Number(/^v?(\d+)/.exec(process.version)?.[1] ?? 0);
  const nodeOk = nodeMajor >= _MIN_NODE_MAJOR_RUNTIME;
  doctorLine(
    nodeOk ? "OK" : "FAIL",
    "Node.js runtime",
    `${process.version} (${process.execPath})`,
  );
  if (!nodeOk) failures += 1;

  if (_isFile(PROJECT_CONFIG_PATH)) {
    try {
      const defaults = loadRunDefaults();
      doctorLine(
        "OK",
        "Project config",
        `${path.resolve(PROJECT_CONFIG_PATH)} (${Object.keys(defaults).length} configured default(s))`,
      );
    } catch (exc) {
      if (!(exc instanceof ProjectConfigError)) throw exc;
      doctorLine("FAIL", "Project config", exc.message);
      failures += 1;
    }
  } else {
    doctorLine("SKIP", "Project config", `${PROJECT_CONFIG_PATH} does not exist`);
  }

  const { AGENT_IDS, agentSpec, probeAgents, reasoningChoices } = await import("./agent_registry.js");

  // `_AGENTS` stays literal so `--help` needs no registry import; this keeps
  // the two from drifting apart silently.
  if (JSON.stringify(_AGENT_CHOICES) !== JSON.stringify([...AGENT_IDS])) {
    doctorLine(
      "FAIL",
      "Agent registry",
      `CLI choices ${JSON.stringify([..._AGENT_CHOICES])} disagree with the registry ${JSON.stringify([...AGENT_IDS])}`,
    );
    failures += 1;
  }

  const foundAgents: Record<string, string> = {};
  const probes = await probeAgents();
  for (const [name, binary] of _AGENTS) {
    const probe = probes[name];
    if (probe === undefined || probe.availability === "missing") {
      doctorLine("WARN", name, probe ? probe.problem : `\`${binary}\` was not found`);
      warnings += 1;
      continue;
    }
    if (probe.availability === "found_but_broken") {
      // On PATH but not runnable is worse than absent: it silently breaks
      // every run, so it is a failure rather than a warning.
      doctorLine("FAIL", name, probe.problem);
      failures += 1;
      continue;
    }
    foundAgents[name] = probe.binary;
    const choices = reasoningChoices(agentSpec(name), probe);
    const effort = choices.length ? `; effort: ${choices.join(", ")}` : "; no effort switch";
    doctorLine("OK", name, `${probe.version} (${probe.binary})${effort}`);
  }

  if (!Object.keys(foundAgents).length) {
    doctorLine("FAIL", "Agent runtime", "install Claude Code and add it to PATH");
    failures += 1;
  }

  warnings += await _doctorNodeToolchain();
  warnings += await _doctorPluginState();

  const updateResult = await updateCheck.result(3.0);
  warnings += _reportUpdateResult(updateResult) ? 1 : 0;

  let summary: string;
  if (failures) summary = `${failures} required check(s) failed`;
  else if (warnings) summary = `ready with ${warnings} warning(s)`;
  else summary = "ready";
  print(`Doctor result: ${summary}`);
  return failures === 0 ? 0 : 1;
}

/** Report the Node/npm toolchain used by npm plugins. */
async function _doctorNodeToolchain(): Promise<number> {
  const { nodeVersion, npmBinary, npmVersion } = await import("./plugins/npm.js");

  let warnings = 0;
  const npm = npmBinary();
  if (!npm) {
    doctorLine(
      "WARN",
      "npm",
      "not found on PATH; `lh-harness plugin install` needs Node.js 20+ (https://nodejs.org)",
    );
    warnings += 1;
  } else {
    doctorLine("OK", "npm", `${(await npmVersion()) || "unknown version"} (${npm})`);
  }

  const node = await nodeVersion();
  if (!node) {
    doctorLine("WARN", "Node.js", "`node --version` was unreadable; npm plugins need Node.js 20+");
    return warnings + 1;
  }
  const majorMatch = /(\d+)/.exec(node);
  const major = majorMatch ? Number(majorMatch[1]) : 0;
  if (major >= _MIN_NODE_MAJOR) {
    doctorLine("OK", "Node.js", node);
  } else {
    doctorLine("WARN", "Node.js", `${node} is older than ${_MIN_NODE_MAJOR}; npm plugins may fail`);
    warnings += 1;
  }
  return warnings;
}

/** Report each computer-use plugin's state, in `plugin list` order. */
async function _doctorPluginState(): Promise<number> {
  const { COMMUNITY_PLUGINS, communityPluginActivation, communityPluginState, globalRegistrations, supportsPlatform } =
    await import("./plugins/community_computer_use.js");
  const { PluginError } = await import("./plugins/errors.js");
  const { npmBinary } = await import("./plugins/npm.js");

  const hint = (name: string): string => `run \`lh-harness plugin install ${name}\``;
  let warnings = 0;

  if (!npmBinary()) {
    for (const plugin of COMMUNITY_PLUGINS) {
      doctorLine("SKIP", plugin.plugin_id, "state unknown while npm is missing");
    }
    return warnings;
  }

  for (const plugin of COMMUNITY_PLUGINS) {
    if (!supportsPlatform(plugin, process.platform)) {
      doctorLine("SKIP", plugin.plugin_id, `does not support ${process.platform}`);
      continue;
    }
    let state;
    try {
      state = await communityPluginState(plugin);
    } catch (exc) {
      if (!(exc instanceof PluginError)) throw exc;
      doctorLine("WARN", plugin.plugin_id, exc.message);
      warnings += 1;
      continue;
    }
    if (!state.installed) {
      doctorLine("SKIP", plugin.plugin_id, `not installed; ${hint(plugin.plugin_id)}`);
      continue;
    }
    doctorLine("OK", plugin.plugin_id, pyStrip(`${plugin.package} ${state.version}`));
    const [ready, detail] = await communityPluginActivation(plugin);
    if (ready === false) {
      doctorLine("WARN", `${plugin.plugin_id} grants`, detail);
      warnings += 1;
    } else if (ready) {
      doctorLine("OK", `${plugin.plugin_id} grants`, detail);
    }
    const leftovers = globalRegistrations(plugin);
    if (leftovers.length) {
      doctorLine(
        "WARN",
        `${plugin.plugin_id} scope`,
        `also registered globally in ${[...new Set(leftovers)].sort().join(", ")}; ` +
          "the harness loads it per run, so remove the global entry to keep GUI " +
          "control out of unrelated sessions",
      );
      warnings += 1;
    }
  }
  return warnings + (await _doctorActivePlugins());
}

/** Report which plugin each agent will load, following the priority order. */
async function _doctorActivePlugins(): Promise<number> {
  const { activePluginForAgent } = await import("./plugins/state.js");
  const { PluginError } = await import("./plugins/errors.js");

  let warnings = 0;
  for (const agent of _MCP_AGENT_CHOICES) {
    let active: [string, string] | null;
    try {
      active = activePluginForAgent(agent);
    } catch (exc) {
      if (!(exc instanceof PluginError)) throw exc;
      doctorLine("WARN", `Computer use (${agent})`, exc.message);
      warnings += 1;
      continue;
    }
    if (active === null) {
      doctorLine(
        "SKIP",
        `Computer use (${agent})`,
        "no plugin installed; GUI subtasks will have no computer-use server",
      );
      continue;
    }
    const [pluginId, config] = active;
    doctorLine("OK", `Computer use (${agent})`, `${pluginId} (${config || "loaded natively by the agent"})`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

async function _pluginCommand(args: Namespace): Promise<number> {
  const { communityPluginIds } = await import("./plugins/community_computer_use.js");
  const { PluginError } = await import("./plugins/errors.js");

  if (JSON.stringify([..._PLUGIN_CHOICES].sort()) !== JSON.stringify([...communityPluginIds()].sort())) {
    throw new Error("CLI plugin choices are stale");
  }

  if (args["plugin_command"] === "list") return await _pluginListCommand();
  try {
    return await _communityPluginCommand(args);
  } catch (exc) {
    if (!(exc instanceof PluginError)) throw exc;
    doctorLine("FAIL", String(args["name"]), exc.message);
    return 1;
  }
}

async function _pluginListCommand(): Promise<number> {
  const { COMMUNITY_PLUGINS, communityPluginActivation, communityPluginState, supportsPlatform } =
    await import("./plugins/community_computer_use.js");
  const { PluginError } = await import("./plugins/errors.js");
  const { npmBinary } = await import("./plugins/npm.js");
  const { PLUGIN_PRIORITY, activePluginForAgent, pluginsRoot } = await import("./plugins/state.js");

  const entry = (name: string, summary: string, fields: Record<string, string>): void => {
    print(`\n${name}`);
    print(`  ${summary}`);
    const width = Math.max(...Object.keys(fields).map((key) => key.length));
    for (const [key, value] of Object.entries(fields)) {
      print(`  ${key.padEnd(width)} : ${value}`);
    }
  };

  print(`Priority when several are installed: ${PLUGIN_PRIORITY.join(" > ")}`);
  print(`Generated MCP configs live under ${pluginsRoot()}`);
  for (const agent of _MCP_AGENT_CHOICES) {
    try {
      const active = activePluginForAgent(agent);
      print(`Active for ${agent}: ${active ? active[0] : "none installed"}`);
    } catch (exc) {
      if (!(exc instanceof PluginError)) throw exc;
      print(`Active for ${agent}: unknown (${exc.message})`);
    }
  }

  const npmMissing = !npmBinary();
  for (const plugin of COMMUNITY_PLUGINS) {
    let grants = "not checked";
    let state: string;
    if (npmMissing) {
      state = "unknown (npm is not on PATH; needs Node.js 20 or later)";
    } else {
      try {
        const packageState = await communityPluginState(plugin);
        state = packageState.installed ? pyStrip(`installed ${packageState.version}`) : "not installed";
        if (packageState.installed) {
          const [ready, detail] = await communityPluginActivation(plugin);
          const prefix = ready === true ? "granted" : ready === false ? "MISSING" : "unknown";
          grants = `${prefix}: ${detail}`;
        }
      } catch (exc) {
        if (!(exc instanceof PluginError)) throw exc;
        state = `unknown (${exc.message})`;
      }
    }
    let platforms = [...plugin.platforms].sort().join(", ");
    if (!supportsPlatform(plugin, process.platform)) platforms += ` (not ${process.platform})`;
    entry(plugin.plugin_id, plugin.summary, {
      source: `npm (${plugin.package})`,
      agents: [...plugin.agents].sort().join(", "),
      platforms,
      grants,
      homepage: plugin.homepage,
      state,
    });
  }
  return 0;
}

async function _communityPluginCommand(args: Namespace): Promise<number> {
  const { getCommunityPlugin, installCommunityPlugin, uninstallCommunityPlugin } = await import(
    "./plugins/community_computer_use.js"
  );
  const { nodeVersion } = await import("./plugins/npm.js");

  const plugin = getCommunityPlugin(String(args["name"]));

  const report = (status: string, message: string): void => {
    doctorLine(status.toUpperCase(), plugin.plugin_id, message);
  };

  if (args["plugin_command"] !== "install") {
    await uninstallCommunityPlugin(plugin, { onStatus: report });
    return 0;
  }

  const requestedRaw = args["agent"];
  const explicit = Array.isArray(requestedRaw) && requestedRaw.length > 0;
  const requested = explicit
    ? (requestedRaw as string[])
    : [...plugin.agents].sort();
  const agents: string[] = [];
  const missing: [string, string][] = [];
  for (const agent of requested) {
    const binary = (_AGENTS.find(([name]) => name === agent) as readonly [string, string, string])[1];
    const cli = await probeAgentCli(binary);
    if (cli.usable) agents.push(agent);
    else missing.push([agent, cli.problem]);
  }
  for (const [agent, problem] of missing) {
    // Writing config for an agent that cannot run would produce a plugin
    // nothing reads. Only an explicit --agent makes this an error.
    const level = explicit ? "FAIL" : "SKIP";
    const suffix = explicit ? "" : "; skipped";
    doctorLine(level, `Agent (${agent})`, `${problem}${suffix}`);
  }
  if (explicit && missing.length) return 1;
  if (!agents.length) {
    doctorLine("FAIL", "Agent", "install Claude Code, then retry");
    return 1;
  }

  print(`Installing ${plugin.plugin_id} for: ${agents.join(", ")}`);
  if (!(await nodeVersion())) {
    doctorLine("WARN", "Node.js", "could not read `node --version`; the plugin may not run");
  }
  await installCommunityPlugin(plugin, {
    agents,
    onStatus: report,
    activate: !args["no_activate"],
  });
  return 0;
}

// ---------------------------------------------------------------------------
// init / check-update
// ---------------------------------------------------------------------------

function _initCommand(args: Namespace): number {
  let target: string;
  try {
    target = createProjectConfig(PROJECT_CONFIG_PATH, Boolean(args["force"]));
  } catch (exc) {
    if (_errno(exc) !== "EEXIST") throw exc;
    eprint(`Config already exists: ${path.resolve(_text(exc))}`);
    eprint("Use `lh-harness init --force` to replace it.");
    return 1;
  }
  print(`Created config: ${path.resolve(target)}`);
  return 0;
}

async function _checkUpdateCommand(): Promise<number> {
  const { checkForUpdate } = await import("./utils/update_check.js");

  const result = await checkForUpdate(VERSION);
  _reportUpdateResult(result);
  return result.status === "failed" ? 1 : 0;
}

type UpdateResult = { status: string; current_version: string; latest_version: string } | null;

function _reportUpdateResult(result: UpdateResult): boolean {
  const projectUrl = "https://www.npmjs.com/package/lh-harness";
  if (result === null || result.status === "failed") {
    doctorLine("WARN", "Update", `automatic update check failed; check manually: ${projectUrl}`);
    return true;
  }
  if (result.status === "update_available") {
    doctorLine(
      "WARN",
      "Update",
      `${result.latest_version} is available (installed: ${result.current_version}); ${projectUrl}`,
    );
    return true;
  }
  doctorLine("OK", "Update", `${result.current_version} is the latest version`);
  return false;
}

// ---------------------------------------------------------------------------
// dashboard / web
// ---------------------------------------------------------------------------

type WebServerRunner = (options: {
  runsRoot?: string | null;
  logDir?: string | null;
  host?: string;
  port?: number;
  workspaceRoot?: string | null;
  authToken?: string | null;
  reloadable?: boolean;
}) => Promise<number>;

/** Import the Web server, keeping the cost off CLI-only invocations. */
async function _loadWebServerRunner(): Promise<WebServerRunner> {
  const { runWebServer } = await import("./webapi/server.js");
  return runWebServer;
}

function _brokenInstallMessage(exc: unknown): string {
  return (
    "Web dependencies are missing from this installation. " +
    "Reinstall with `npm install -g lh-harness`. " +
    `(${_text(exc)})`
  );
}

/** Run the React workbench. */
async function _dashboardCommand(args: Namespace): Promise<number> {
  let runWebServer: WebServerRunner;
  try {
    runWebServer = await _loadWebServerRunner();
  } catch (exc) {
    eprint(_brokenInstallMessage(exc));
    return 2;
  }
  return await _serveWebWorkbench(args, runWebServer);
}

/** Run the HTTP/WebSocket control plane in the foreground. */
async function _webCommand(args: Namespace): Promise<number> {
  let runWebServer: WebServerRunner;
  try {
    runWebServer = await _loadWebServerRunner();
  } catch (exc) {
    eprint(_brokenInstallMessage(exc));
    return 2;
  }
  return await _serveWebWorkbench(args, runWebServer);
}

/** Apply shared CLI policy and run the Web workbench in the foreground. */
async function _serveWebWorkbench(args: Namespace, runWebServer: WebServerRunner): Promise<number> {
  const host = String(args["host"]);
  const port = Number(args["port"]);
  const authToken = (args["auth_token"] ?? null) as string | null;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !authToken) {
    eprint("Refusing remote Web control API without --auth-token or LH_HARNESS_WEB_TOKEN.");
    return 2;
  }
  const url = ["0.0.0.0", "::"].includes(host)
    ? `http://127.0.0.1:${port}/`
    : `http://${host}:${port}/`;
  if (!args["no_open"] && port) {
    // ``runWebServer`` blocks until interrupted. Open from a waiter, but only
    // after the root page actually responds; opening before bind/start races
    // the browser into a connection-error page on slower machines.
    const { openBrowserWhenReady } = await import("./webapi/server.js");
    void openBrowserWhenReady(url);
  } else if (!args["no_open"]) {
    print("API port is assigned by the OS; automatic browser opening is disabled until the port is known.");
  }
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  try {
    const code = await runWebServer({
      runsRoot: args["runs_root"] as string,
      logDir: (args["log_dir"] ?? null) as string | null,
      host,
      port,
      workspaceRoot: args["workspace_root"] as string,
      authToken,
      // Set by `lh-harness start` (host wrapper) and by the container image:
      // both know how to bring the service back after an exit-87 reload.
      reloadable: process.env["LH_HARNESS_ENABLE_RELOAD"] === "1",
    });
    if (interrupted) print("Web API stopped.");
    return code;
  } catch (exc) {
    eprint(_text(exc));
    return 2;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface DashboardHandle {
  url: string;
  host: string;
  port: number;
  state: unknown;
  close(): Promise<void>;
}

/** Write best-effort endpoint discovery metadata next to a run. */
function _writeDashboardEndpoint(
  target: string,
  handle: DashboardHandle,
  options: { runId: string; logDir: string },
): void {
  try {
    const endpoint = {
      service: "lh-harness",
      run_id: options.runId,
      url: String(handle.url),
      host: String(handle.host ?? "127.0.0.1"),
      port: Number(handle.port),
      pid: process.pid,
      log_dir: _resolvePath(options.logDir),
      started_at: Date.now() / 1000,
    };
    _atomicBytesWrite(target, Buffer.from(`${JSON.stringify(endpoint, null, 2)}\n`, "utf-8"));
  } catch (exc) {
    eprint(`Warning: could not write dashboard endpoint file: ${_text(exc)}`);
  }
}

/**
 * Best-effort durable owner cleanup for an in-process dashboard.
 *
 * Dashboard cleanup must never hide the manager's real result, so startup or
 * shutdown errors are reported to stderr while the run itself remains the
 * source of truth.
 */
function _finalizeEmbeddedSupervisor(
  supervisor: { finalizeAttachedRun?: unknown } | null,
  runId: string,
  options: {
    report?: Record<string, unknown> | null;
    returncode?: number | null;
    reason?: string;
  } = {},
): void {
  if (supervisor === null) return;
  try {
    const finalize = supervisor.finalizeAttachedRun;
    if (typeof finalize !== "function") throw new TypeError("finalize_attached_run is unavailable");
    finalize.call(supervisor, runId, {
      report: options.report ?? null,
      returncode: options.returncode === undefined ? 0 : options.returncode,
      reason: options.reason ?? "",
    });
  } catch (exc) {
    eprint(`Warning: could not finalize embedded dashboard owner: ${_text(exc)}`);
  }
}

/** Separate stopping a run from shutting down its embedded Web server. */
export async function shouldKeepEmbeddedDashboard(
  runDir: string,
  options: { explicitlyRequested: boolean; report: Record<string, unknown> | null },
): Promise<boolean> {
  if (options.explicitlyRequested && options.report !== null) return true;
  let requestedAction: string;
  try {
    const { ControlBus } = await import("./supervisor/control_bus.js");
    requestedAction = pyStrip(String(new ControlBus(runDir).readStatus()["requested_action"] ?? "")).toLowerCase();
  } catch {
    return false;
  }
  return ["stop", "abort", "cancel"].includes(requestedAction);
}

/**
 * Cancel an embedded Manager run from its durable lifecycle request.
 *
 * The Web server runs in the same process as the Manager. Its Stop/Abort routes
 * therefore persist an intent instead of signalling the hosting PID. This
 * watcher crosses that boundary via the run's ControlBus and aborts the manager.
 */
export async function runWithAttachedControl(
  start: (signal: AbortSignal | null) => Promise<Record<string, unknown>>,
  options: { runDir: string; enabled: boolean; pollInterval?: number },
): Promise<Record<string, unknown>> {
  const pollInterval = options.pollInterval ?? 0.1;
  if (!options.enabled) return await start(null);

  const { ControlBus } = await import("./supervisor/control_bus.js");
  const bus = new ControlBus(options.runDir);
  const controller = new AbortController();
  const worker = start(controller.signal);
  let done = false;
  let watcherError: unknown = null;

  const watch = async (): Promise<void> => {
    while (!done) {
      // A stolen-descriptor EBADF must cost one poll, not the whole watcher: if
      // this task dies, stop/abort requests go unheard for the rest of the run.
      // Only EBADF is recoverable noise; permission, I/O, or filesystem failures
      // would silently blind the watcher, so they propagate.
      let status: Record<string, unknown>;
      try {
        status = bus.readStatus();
      } catch (exc) {
        if (_errno(exc) !== "EBADF") throw exc;
        status = {};
      }
      const action = pyStrip(String(status["requested_action"] ?? "")).toLowerCase();
      if (action === "stop" || action === "abort") {
        controller.abort();
        return;
      }
      await _sleep(pollInterval);
    }
  };

  const watcher = watch().catch((exc: unknown) => {
    watcherError = exc;
  });
  try {
    return await worker;
  } finally {
    done = true;
    await watcher;
    if (watcherError !== null && _errno(watcherError) !== "EBADF") {
      // eslint-disable-next-line no-unsafe-finally
      throw watcherError;
    }
  }
}

function _sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function _runCommand(args: Namespace): Promise<number> {
  // The agents work in the directory lh-harness was started from, so a task acts
  // on the user's real project by default. Resolve it before touching the disk:
  // every other path below is relative to it.
  let workspace: string;
  if (args["workspace"]) {
    workspace = _resolvePath(String(args["workspace"]));
    fs.mkdirSync(workspace, { recursive: true });
  } else {
    workspace = DEFAULT_WORKSPACE_PATH;
    if (!_isDir(workspace)) {
      eprint(
        `The launch directory no longer exists: ${workspace}\n` +
          "cd into an existing directory, or pass --workspace.",
      );
      return 1;
    }
  }

  // ``--resume`` reopens an existing run directory and continues its ledger.
  // Only the supervisor may do that: it is the component that verifies the run
  // is terminal, owns the reservation, and bumps the resume generation.
  // Allowing it standalone would let any caller reattach to another run.
  if (args["resume"] && !args["supervised"]) {
    eprint("Cannot start run: --resume is only available to supervised workers");
    return 2;
  }

  let maxRounds = args["max_rounds"] as number | null;
  if (maxRounds === null || maxRounds === undefined) {
    maxRounds = _DEFAULT_MAX_ROUNDS;
    print(`--max-rounds was not set; using the default of ${maxRounds} rounds.`);
  }
  if (
    typeof maxRounds !== "number" ||
    !Number.isInteger(maxRounds) ||
    !(maxRounds >= 1 && maxRounds <= MAX_ROUNDS)
  ) {
    eprint(`Cannot start run: max_rounds must be an integer from 1 to ${MAX_ROUNDS}`);
    return 2;
  }

  const supervised = Boolean(args["supervised"]);
  const runsRoot = String(args["runs_root"]);
  const agentName = String(args["agent"]);
  const model = (args["model"] ?? null) as string | null;

  // Validate the supervisor reservation before opening any task reference.
  // Otherwise a malformed ``--supervised --task=@...`` invocation could make
  // this worker read an arbitrary regular file even though adoption would later
  // be rejected by the owner/status checks.
  let preAdopted: [string, string] | null = null;
  let task: string;
  try {
    if (supervised) {
      preAdopted = adoptSupervisedRunDir(runsRoot, (args["run_id"] ?? null) as string | null, {
        task: null,
        agent: agentName,
        model,
        roleConfigs: publicRoleConfigsFromArgs(args),
        workspace,
        maxRounds,
      });
      task = readSupervisedTask(String(args["task"]), preAdopted[1]);
    } else {
      task = readTask(String(args["task"]));
    }
  } catch (exc) {
    eprint(`Cannot start run: ${_text(exc)}`);
    return 2;
  }

  // Each run is fully isolated under <runs-root>/<run-id>/ so a new run never
  // mixes with a previous run's tmp/log/workspace data (and the dashboard shows
  // only the current run).
  let runId: string;
  let runDir: string;
  try {
    if (supervised) {
      // The supervisor has already reserved this directory and bound its owner
      // PID. Do not call reserveRunDir(), which would correctly reject an
      // existing directory for ordinary CLI invocations.
      [runId, runDir] = adoptSupervisedRunDir(runsRoot, (args["run_id"] ?? null) as string | null, {
        task,
        agent: agentName,
        model,
        roleConfigs: publicRoleConfigsFromArgs(args),
        workspace,
        maxRounds,
      });
      if (preAdopted !== null && runId !== preAdopted[0]) {
        throw new Error("supervised run reservation changed during bootstrap");
      }
      await claimSupervisedOwner(runId, runDir);
    } else {
      [runId, runDir] = reserveRunDir(runsRoot, (args["run_id"] ?? null) as string | null);
    }
  } catch (exc) {
    eprint(`Cannot start run: ${_text(exc)}`);
    return 2;
  }

  const logDir = args["log_dir"]
    ? expandUser(String(args["log_dir"]))
    : path.join(runDir, "lh_harness");
  if (supervised) {
    // Supervisor workers always write into their reservation. A hidden flag
    // must not turn into a way to redirect logs/metadata elsewhere.
    let escapes = true;
    try {
      escapes = !_isRelativeTo(_resolvePath(logDir), _resolvePath(runDir));
    } catch {
      escapes = true;
    }
    if (escapes) {
      eprint("Cannot start run: supervised log directory escapes the run reservation");
      return 2;
    }
  }
  const promptPath = path.join(runDir, "tmp", "prompts");
  const promptDir = promptPath;
  const harnessDir = args["harness_dir"]
    ? expandUser(String(args["harness_dir"]))
    : _resolvePath(path.join(runDir, "harness"));
  try {
    fs.mkdirSync(workspace, { recursive: true });
    // Logs, prompts, and task scratch space are part of the run boundary. An
    // agent must not be able to redirect any of them through a swapped
    // parent-directory symlink during worker bootstrap.
    _ensureDirNofollow(logDir);
    _ensureDirNofollow(promptPath);
  } catch (exc) {
    eprint(`Cannot start run: unsafe run directory layout: ${_text(exc)}`);
    return 2;
  }

  // The workspace is the user's own directory, so the run's bookkeeping may sit
  // inside it. Hide those paths from the agents and from the auditor read-only
  // guard, which would otherwise flag the harness's own writes.
  const hiddenPaths = outermostPaths(
    path.dirname(PROJECT_CONFIG_PATH),
    runsRoot,
    runDir,
    logDir,
    harnessDir,
    promptDir,
  );

  // Volatile workspace paths the read-only guard skips while snapshotting.
  // Unlike hiddenPaths these stay readable to the agents: excluding them only
  // stops the guard from racing a directory that legitimately churns (build
  // outputs) during an audit window.
  let guardExcludePaths: readonly string[];
  try {
    guardExcludePaths = resolveGuardExcludePaths((args["guard_exclude_path"] as string[]) || [], {
      workspace,
      protected: [
        path.dirname(PROJECT_CONFIG_PATH),
        runsRoot,
        runDir,
        logDir,
        harnessDir,
        promptDir,
      ],
    });
  } catch (exc) {
    eprint(`Cannot start run: ${_text(exc)}`);
    return 2;
  }

  print(`Run id:    ${runId}`);
  print(`Run dir:   ${_resolvePath(runDir)}`);
  print(`Workspace: ${workspace}`);
  print(`Log dir:   ${_resolvePath(logDir)}`);
  if (guardExcludePaths.length) {
    // Make the audit's reduced coverage part of the run's console record; each
    // audited episode also carries the list in its metadata.
    print(`Guard excludes: ${guardExcludePaths.join(", ")}`);
  }

  const config: HarnessConfig = harnessConfig({
    max_total_episodes: maxRounds,
    manager_budget: new EpisodeBudget(Number(args["manager_timeout"])),
    gui_executor_budget: new EpisodeBudget(Number(args["gui_executor_timeout"])),
    cli_executor_budget: new EpisodeBudget(Number(args["cli_executor_timeout"])),
    auditor_budget: new EpisodeBudget(Number(args["auditor_timeout"])),
    workspace_path: workspace,
    harness_dir: harnessDir,
    log_dir: logDir,
    prompt_language: String(args["prompt_language"]) as PromptLanguage,
  });
  const env = await buildEnv(String(args["env"]), path.join(runDir, "tmp"));

  // The dashboard starts before agent creation so startup status is visible.
  let dashboardHandle: DashboardHandle | null = null;
  let humanHook: ((context: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;
  let gateState: DashboardState | null = null;
  let dashboardSupervisor: { finalizeAttachedRun?: unknown } | null = null;
  if (supervised) {
    const { makeHumanHook } = await import("./dashboard/gate.js");
    const { DashboardState } = await import("./dashboard/state.js");

    // A Worker has no HTTP server of its own. It still needs the same durable
    // human gate adapter so a separate Supervisor/API process can resolve
    // approvals and queue instructions through the run control bus.
    const workerState = new DashboardState(logDir, { task, controlEnabled: true });
    humanHook = makeHumanHook(workerState);
    gateState = workerState;
  }
  if (args["dashboard"]) {
    const { makeHumanHook } = await import("./dashboard/gate.js");
    try {
      const { startWebServer } = await import("./webapi/server.js");
      const { RunSupervisor } = await import("./supervisor/service.js");

      // This invocation owns the worker process itself (there is no parent
      // process handle), so attach a restricted supervisor to the current run.
      // It enables safe stop/abort and status projection while deliberately
      // disallowing create/resume of unrelated workers from the embedded
      // dashboard.
      const supervisor = new RunSupervisor(runsRoot, {
        workspaceRoot: workspace,
        attachedOnly: true,
      });
      dashboardSupervisor = supervisor;
      supervisor.attachRun({
        runId,
        pid: process.pid,
        task,
        agent: agentName,
        model,
        roleConfigs: publicRoleConfigsFromArgs(args),
        workspace,
        maxRounds,
        promptLanguage: String(args["prompt_language"]),
        command: [process.execPath, ...process.argv.slice(1)],
      });

      dashboardHandle = (await startWebServer({
        logDir,
        runsRoot,
        runId,
        task,
        controlEnabled: Boolean(task),
        workspaceRoot: workspace,
        host: String(args["dashboard_host"]),
        port: Number(args["dashboard_port"]),
        supervisor,
        authToken: (args["dashboard_auth_token"] ?? null) as string | null,
      })) as unknown as DashboardHandle;
    } catch (exc) {
      // attachRun may have written an owner before a bind/auth failure. Do not
      // leave an embedded dashboard advertising a live worker when no server
      // was actually started.
      const bindFailure = _isBindOrAuthFailure(exc);
      _finalizeEmbeddedSupervisor(dashboardSupervisor, runId, {
        report: { status: "failed" },
        returncode: 2,
        reason: bindFailure
          ? "embedded dashboard refused to start"
          : `dashboard startup failed: ${_text(exc)}`,
      });
      eprint(
        bindFailure
          ? `Dashboard refused to start: ${_text(exc)}`
          : `Dashboard failed to start: ${_text(exc)}`,
      );
      return 2;
    }
    humanHook = makeHumanHook(dashboardHandle.state as DashboardState);
    gateState = dashboardHandle.state as DashboardState;
    print(`Dashboard live at ${dashboardHandle.url} (log dir: ${logDir})`);
    _writeDashboardEndpoint(path.join(runDir, "dashboard.json"), dashboardHandle, { runId, logDir });
    if (!args["dashboard_no_open"]) {
      const { openBrowserWhenReady } = await import("./webapi/server.js");
      await openBrowserWhenReady(dashboardHandle.url);
    }
  }

  const agentCache = new Map<string, AgentAdapter>();
  const pluginMcpCache = new Map<string, string | null>();

  const resolveMcpConfig = async (name: string): Promise<string | null> => {
    // The agent's own --*-mcp-config wins; otherwise the installed computer-use
    // plugin with the highest priority is loaded for this agent.
    const override = args[_MCP_CONFIG_DESTS[name] ?? ""];
    if (override) return String(override);
    if (!pluginMcpCache.has(name)) {
      const { activePluginForAgent } = await import("./plugins/state.js");
      const { PluginError } = await import("./plugins/errors.js");

      let active: [string, string] | null;
      try {
        active = activePluginForAgent(name);
      } catch (exc) {
        if (!(exc instanceof PluginError)) throw exc;
        eprint(`Warning: could not read the plugin state: ${exc.message}`);
        active = null;
      }
      if (active === null) {
        pluginMcpCache.set(name, null);
      } else {
        const [pluginId, config] = active;
        const origin = config || "loaded natively by the agent";
        print(`Computer use for ${name}: ${pluginId} (${origin})`);
        pluginMcpCache.set(name, config || null);
      }
    }
    return pluginMcpCache.get(name) ?? null;
  };

  const buildRoleAgent = async (role: string, permissionRole?: string): Promise<AgentAdapter> => {
    // Agent and model resolve independently down the same fallback chain, so
    // mixing backends never sends one backend the other's model id. The
    // permission role is part of the cache key: two Claude roles using the same
    // model must never share a differently privileged adapter.
    const name = resolveRoleOption(args, role, "agent") ?? agentName;
    const roleModel = resolveRoleModel(args, role);
    const effort = resolveRoleReasoningEffort(args, role, name);
    const effectivePermissionRole = permissionRole ?? role;
    const key = JSON.stringify([effectivePermissionRole, name, roleModel, effort]);
    if (!agentCache.has(key)) {
      agentCache.set(
        key,
        await buildAgent(name, {
          role: effectivePermissionRole,
          model: roleModel,
          apiKey: (args["api_key"] ?? null) as string | null,
          baseUrl: (args["base_url"] ?? null) as string | null,
          workspacePath: workspace,
          promptDir,
          mcpConfig: await resolveMcpConfig(name),
          mcpAddDirs: (args["mcp_add_dir"] as string[]) ?? null,
          hiddenPaths,
          guardExcludePaths,
          reasoningEffort: effort,
        }),
      );
    }
    return agentCache.get(key) as AgentAdapter;
  };

  let roleAgents: Record<string, AgentAdapter>;
  try {
    roleAgents = {
      managerAgent: await buildRoleAgent("manager"),
      guiExecutorAgent: await buildRoleAgent("gui_executor"),
      cliExecutorAgent: await buildRoleAgent("cli_executor"),
      guiAuditorAgent: await buildRoleAgent("gui_auditor"),
      cliAuditorAgent: await buildRoleAgent("cli_auditor"),
      // Format repair sees only the previous auditor text and has no tools. It
      // inherits the selected auditor backend/model, but never its audit
      // permissions.
      auditorFormatRepairAgent: await buildRoleAgent("auditor", "auditor_format_repair"),
      finalResponseAgent: await buildRoleAgent("final_response"),
    };
  } catch (exc) {
    writeBootstrapFailure(logDir, task, exc, maxRounds);
    eprint(`Worker failed during agent setup: ${_text(exc)}`);
    _finalizeEmbeddedSupervisor(dashboardSupervisor, runId, {
      report: { status: "failed" },
      returncode: 1,
      reason: "worker bootstrap failure",
    });
    if (dashboardHandle !== null) await dashboardHandle.close();
    return 1;
  }

  const { run } = await import("./manager.js");

  const injectionSource = gateState;
  let report: Record<string, unknown> | null = null;
  try {
    report = await runWithAttachedControl(
      (signal) =>
        run({
          task,
          env,
          config,
          humanHook,
          pendingInstructions:
            injectionSource !== null ? () => injectionSource.drainInjections() : null,
          progress: printProgress,
          resume: Boolean(args["resume"]),
          signal,
          ...roleAgents,
        }),
      { runDir, enabled: dashboardSupervisor !== null },
    );
    // A hosted dashboard keeps this same PID alive after Manager returns;
    // finalize before entering that serving loop so the right panel and later
    // API clients see a terminal run immediately.
    _finalizeEmbeddedSupervisor(dashboardSupervisor, runId, { report, returncode: 0 });
  } catch (exc) {
    _finalizeEmbeddedSupervisor(dashboardSupervisor, runId, {
      report: { status: "failed" },
      returncode: 1,
      reason: `worker failed: ${_text(exc)}`,
    });
    throw exc;
  } finally {
    // The summary is printed before the dashboard blocks, so the outcome is
    // visible in the console even when the operator leaves the UI running.
    if (report !== null) printRunSummary(report, { logDir, workspace });
    if (dashboardHandle !== null) {
      const keep = await shouldKeepEmbeddedDashboard(runDir, {
        explicitlyRequested: Boolean(args["keep_dashboard"]),
        report,
      });
      if (keep) {
        print(`\nDashboard still live at ${dashboardHandle.url}; press Ctrl+C to exit.`);
        await _blockUntilInterrupt();
      }
      await dashboardHandle.close();
    }
  }

  const finalReport = report ?? { status: "failed", completion_satisfied: false };
  return finalReport["completion_satisfied"] ? 0 : 1;
}

/** `serve_forever_blocking()` has no TS equivalent; wait for Ctrl+C instead. */
function _blockUntilInterrupt(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** `start_web_server` raises `ValueError` in Python for bind/auth problems. */
function _isBindOrAuthFailure(exc: unknown): boolean {
  const code = _errno(exc);
  if (["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(code)) return true;
  return /refusing to expose|auth|token|bind/i.test(_text(exc));
}

function _isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve paths and drop any that sit inside another, keeping the parents. */
export function outermostPaths(...paths: string[]): readonly string[] {
  const resolved = [...new Set(paths.map((item) => _resolvePath(item)))].sort((left, right) => {
    const depth = _depth(left) - _depth(right);
    return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
  });
  const kept: string[] = [];
  for (const item of resolved) {
    if (!kept.some((parent) => _isRelativeTo(item, parent))) kept.push(item);
  }
  return kept;
}

function _depth(target: string): number {
  return target.split(path.sep).filter(Boolean).length;
}

const _REPEATABLE_RUN_OPTIONS = ["mcp_add_dir", "guard_exclude_path"] as const;

/**
 * Let the command line replace a repeatable project-config list.
 *
 * `action="append"` appends to whatever default argparse holds, so giving it the
 * config list directly makes `--flag` extend the config instead of overriding it
 * - the opposite of how every scalar option behaves. These options therefore
 * default to `null` and adopt the config only when the command line said
 * nothing. A fresh list is built so nothing later mutates the cached defaults.
 */
export function applyRepeatableDefaults(args: Namespace, runDefaults: Record<string, unknown>): void {
  for (const name of _REPEATABLE_RUN_OPTIONS) {
    if (args[name] !== null && args[name] !== undefined) continue;
    const configured = runDefaults[name];
    args[name] = Array.isArray(configured) ? [...configured] : [];
  }
}

/**
 * Resolve and validate the auditor guard's snapshot exclusions.
 *
 * The guard is the only witness of workspace mutations, and the agents keep Bash
 * access to excluded paths, so every exclusion is a hole in the audit. Constrain
 * the holes: an exclusion must stay inside the workspace, must not disable the
 * guard wholesale, and must not cover a path the audit exists to protect - the
 * VCS history and the harness's own control/state directories. Throws with an
 * operator-facing message on the first violation.
 */
export function resolveGuardExcludePaths(
  raw: readonly string[],
  options: { workspace: string; protected: Iterable<string> },
): readonly string[] {
  const workspace = _resolvePath(options.workspace);
  const protectedPaths = new Set([...options.protected].map((item) => _resolvePath(item)));
  const resolved: string[] = [];
  for (const item of raw) {
    let candidate = expandUser(item);
    if (!path.isAbsolute(candidate)) candidate = path.join(workspace, candidate);
    candidate = _resolvePath(candidate);
    if (!_isRelativeTo(candidate, workspace)) {
      throw new Error(
        `guard exclude path escapes the workspace: ${_pyReprStr(item)} resolves to ${candidate}`,
      );
    }
    if (candidate === workspace) {
      throw new Error(
        `guard exclude path would disable the read-only guard entirely: ${_pyReprStr(item)}`,
      );
    }
    if (_relativeParts(candidate, workspace).includes(".git")) {
      throw new Error(`guard exclude path may not touch version-control state: ${_pyReprStr(item)}`);
    }
    const clashing = [...protectedPaths].find(
      (shielded) => _isRelativeTo(shielded, candidate) || _isRelativeTo(candidate, shielded),
    );
    if (clashing !== undefined) {
      throw new Error(
        `guard exclude path may not cover harness state (${clashing}): ${_pyReprStr(item)}`,
      );
    }
    if (!resolved.includes(candidate)) resolved.push(candidate);
  }
  return resolved;
}

/** Python's `repr()` for the short strings these messages embed. */
function _pyReprStr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Print one console line per role transition so a long run stays legible. */
export function printProgress(event: string, payload: Record<string, unknown>): void {
  const roundIndex = payload["round"];
  if (event === "round_start") {
    print(`\n── Round ${roundIndex}/${payload["round_budget"]} ──`);
  } else if (event === "role_start") {
    // The reply is written when the run reaches an ending, so it gets its own
    // heading instead of appearing to be part of that round's work.
    if (payload["role"] === "final_response") print("\n── Writing reply ──");
    print(`  [${payload["role"]}] running...`);
  } else if (event === "role_done") {
    const parts = [String(payload["status"])];
    const durationMs = payload["duration_ms"];
    if (typeof durationMs === "number" && Number.isInteger(durationMs)) {
      parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    }
    if (payload["next_step"]) parts.push(`next=${payload["next_step"]}`);
    if (payload["audit_status"]) {
      parts.push(
        `audit=${payload["audit_status"]}/` +
          `${payload["integrity_status"]}/${payload["contract_audit_status"]}`,
      );
    }
    print(`  [${payload["role"]}] ${parts.join(" · ")}`);
  }
}

export function printRunSummary(
  report: Record<string, unknown>,
  options: { logDir: string; workspace: string },
): void {
  print(`\n${"=".repeat(72)}`);
  print(`Result:    ${report["status"]}`);
  print(`Rounds:    ${report["rounds_run"]}/${report["max_rounds"]}`);
  const elapsed = report["elapsed_seconds"];
  if (typeof elapsed === "number") print(`Elapsed:   ${(elapsed / 60).toFixed(1)} min`);
  if (report["abort_reason"]) print(`Stopped:   ${report["abort_reason"]}`);
  print(`Workspace: ${options.workspace}`);
  print(`Report:    ${path.join(_resolvePath(options.logDir), "report.json")}`);

  // The reply answers the task in prose, so it leads. The protocol artifacts
  // below it stay for anyone auditing how that answer was reached.
  const response = pyStrip(String(report["final_response"] ?? ""));
  if (response) {
    print(`\n${"-".repeat(72)}`);
    print(_indent(response));
    print("-".repeat(72));
  }
  for (const [label, key] of [
    ["Task state", "current_task_state"],
    ["Final audit", "latest_auditor_report"],
  ] as const) {
    const text = pyStrip(String(report[key] ?? ""));
    if (text) print(`\n${label}:\n${_indent(text)}`);
  }
  print("=".repeat(72));
}

function _indent(text: string, prefix = "  "): string {
  return text.split("\n").map((line) => prefix + line).join("\n");
}

/** Return effective Manager/Executor/Auditor bindings when overridden. */

// ---------------------------------------------------------------------------
// `lh-harness start` — one-command workflow for a project folder (addition
// over upstream). Host mode wraps `web` in a relaunch loop so the Reload
// button restarts the service on current source; --docker runs the whole
// stack in a per-folder container whose only writable state is the
// bind-mounted folder itself.
// ---------------------------------------------------------------------------

const _RELOAD_EXIT_CODE = 87;

export function startContainerName(workspace: string): string {
  const resolved = path.resolve(workspace);
  const slug = (path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "workspace").slice(0, 30);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 6);
  return `lh-harness-${slug}-${digest}`;
}

export function ensureWebToken(workspace: string): string {
  const dir = path.join(workspace, ".lh-harness");
  const target = path.join(dir, "web-token");
  try {
    const existing = pyStrip(fs.readFileSync(target, "utf-8"));
    if (existing) return existing;
  } catch {
    /* absent: mint one below */
  }
  fs.mkdirSync(dir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  fs.writeFileSync(target, `${token}\n`, { mode: 0o600 });
  return token;
}

const _DOCKER_ENV_TEMPLATE = `# lh-harness sandbox credentials (user-scoped; read by every \`start --docker\`).
# Fill in ONE auth method for the agents inside the container:
#   CLAUDE_CODE_OAUTH_TOKEN — run \`claude setup-token\` where you are logged in
#   or ANTHROPIC_API_KEY    — a console.anthropic.com key (per-token billing)
CLAUDE_CODE_OAUTH_TOKEN=
# ANTHROPIC_API_KEY=
# Third-party provider keys (sdk/providers.json) go here too, e.g.:
# ORCA_API_KEY=
`;

function ensureDockerEnvFile(): [string, boolean] {
  const target = path.join(DEFAULT_STATE_ROOT, "docker.env");
  let content = "";
  try {
    content = fs.readFileSync(target, "utf-8");
  } catch {
    fs.mkdirSync(DEFAULT_STATE_ROOT, { recursive: true });
    fs.writeFileSync(target, _DOCKER_ENV_TEMPLATE, { mode: 0o600 });
    content = _DOCKER_ENV_TEMPLATE;
  }
  // Horizontal whitespace only: `\s` would run across the newline and let the
  // template's empty `TOKEN=` line match the next line's `#`.
  const hasAuth = /^[ \t]*(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)[ \t]*=[ \t]*\S+/mu.test(content);
  return [target, hasAuth];
}

function harnessPackageRoot(): string {
  // src/cli.ts -> the sdk package directory; its parent holds docker/.
  return path.dirname(path.dirname(fileURLToPath(new URL(import.meta.url))));
}

function _docker(argv: string[], options: { inherit?: boolean } = {}): { status: number; stdout: string } {
  const result = child_process.spawnSync("docker", argv, {
    encoding: "utf-8",
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

async function _startCommand(args: Namespace): Promise<number> {
  const workspace = process.cwd();
  const port = Number(args["port"]);
  const created = !_isFile(PROJECT_CONFIG_PATH);
  if (created) {
    createProjectConfig();
    print(`Created config: ${path.resolve(PROJECT_CONFIG_PATH)}`);
  } else {
    print(`Using config: ${path.resolve(PROJECT_CONFIG_PATH)}`);
  }
  if (!args["docker"]) return await _startHost(workspace, port, Boolean(args["no_open"]));
  return await _startDocker(workspace, port, Boolean(args["no_open"]));
}

/** Relaunch loop: a child `web` process per generation, so an exit-87 reload
 * re-imports the harness source from disk. */
async function _startHost(workspace: string, port: number, noOpen: boolean): Promise<number> {
  const sdkRoot = path.dirname(harnessPackageRoot()) === workspace ? harnessPackageRoot() : harnessPackageRoot();
  const cliPath = path.join(sdkRoot, "src", "cli.ts");
  const loader = import.meta.resolve("tsx");
  let generation = 0;
  for (;;) {
    generation += 1;
    if (generation > 1) print("Reloading the harness on current source…");
    const child = child_process.spawn(
      process.execPath,
      [
        "--import",
        loader,
        cliPath,
        "web",
        "--workspace-root",
        workspace,
        "--runs-root",
        path.join(workspace, ".lh-harness", "runs"),
        "--port",
        String(port),
        ...(noOpen || generation > 1 ? ["--no-open"] : []),
      ],
      {
        cwd: workspace,
        stdio: "inherit",
        env: { ...process.env, LH_HARNESS_ENABLE_RELOAD: "1" },
      },
    );
    const code = await new Promise<number>((resolve) => {
      child.on("exit", (value, signal) => resolve(signal ? 130 : (value ?? 1)));
    });
    if (code !== _RELOAD_EXIT_CODE) return code;
  }
}

async function _startDocker(workspace: string, port: number, noOpen: boolean): Promise<number> {
  const packageRoot = harnessPackageRoot();
  const harnessRoot = path.dirname(packageRoot);
  try {
    if (_docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
      eprint("Docker is installed but the daemon is not responding. Start Docker Desktop and retry.");
      return 2;
    }
  } catch {
    eprint("Docker is not installed (or not on PATH). Install Docker Desktop, or run `lh-harness start` without --docker.");
    return 2;
  }
  const [envFile, hasAuth] = ensureDockerEnvFile();
  if (!hasAuth) {
    eprint(`No agent credentials configured for the sandbox.`);
    eprint(`Put CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or ANTHROPIC_API_KEY into ${envFile}, then rerun.`);
    return 2;
  }
  const dist = path.join(packageRoot, "frontend", "web", "dist", "index.html");
  if (!_isFile(dist)) {
    eprint(`The workbench bundle is missing (${dist}). Run \`npm run build:web\` in ${packageRoot} first.`);
    return 2;
  }
  print("Building the sandbox image (cached after the first build)…");
  if (_docker(["build", "-f", path.join(harnessRoot, "docker", "Dockerfile"), "-t", "lh-harness:latest", harnessRoot], { inherit: true }).status !== 0) {
    eprint("Image build failed; see the output above.");
    return 2;
  }
  const token = ensureWebToken(workspace);
  const name = startContainerName(workspace);
  const inspect = _docker(["inspect", "--format", "{{.State.Status}} {{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}}{{end}}{{end}}", name]);
  if (inspect.status === 0) {
    const [, boundPort] = pyStrip(inspect.stdout).split(/\s+/u);
    if (boundPort && boundPort !== String(port)) {
      print(`Recreating ${name}: it was bound to port ${boundPort}, requested ${port}.`);
      _docker(["rm", "-f", name]);
    } else {
      // Restart (not just start): the harness source is bind-mounted, so a
      // restart is also how an already-running sandbox picks up new code.
      print(`Reusing sandbox ${name} (state is on this folder; nothing is lost).`);
      if (_docker(["restart", name]).status !== 0) {
        eprint(`Could not restart ${name}; see \`docker logs ${name}\`.`);
        return 2;
      }
      return await _startDockerReady(name, port, token, noOpen);
    }
  }
  const mounts = [
    ["-v", `${workspace}:/work`],
    // The harness engineering itself, read-only over the image's copy: the
    // sandbox always runs the source currently in the harness repo, and the
    // Reload button (container restart) picks up edits without a rebuild.
    ["-v", `${path.join(packageRoot, "src")}:/app/sdk/src:ro`],
    ["-v", `${path.join(packageRoot, "bin")}:/app/sdk/bin:ro`],
    ["-v", `${path.join(packageRoot, "providers.json")}:/app/sdk/providers.json:ro`],
    ["-v", `${path.join(packageRoot, "frontend", "web", "dist")}:/app/sdk/frontend/web/dist:ro`],
  ].flat();
  const run = _docker([
    "run",
    "-d",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    "-p",
    `127.0.0.1:${port}:8799`,
    ...mounts,
    "--env-file",
    envFile,
    "-e",
    `LH_HARNESS_WEB_TOKEN=${token}`,
    "-e",
    "LH_HARNESS_ENABLE_RELOAD=1",
    "lh-harness:latest",
    "web",
  ]);
  if (run.status !== 0) {
    eprint(`Could not start the sandbox container; see \`docker logs ${name}\` (or the output above).`);
    return 2;
  }
  return await _startDockerReady(name, port, token, noOpen);
}

async function _startDockerReady(name: string, port: number, token: string, noOpen: boolean): Promise<number> {
  const url = `http://127.0.0.1:${port}/`;
  const { waitForDashboardReady, openBrowserWhenReady } = await import("./webapi/server.js");
  const ready = await waitForDashboardReady(url, { timeout: 30 });
  print("");
  print(`Sandbox:   ${name} (restart policy: unless-stopped — survives Docker restarts)`);
  print(`Workbench: ${url}`);
  print(`Token:     ${token}`);
  print(`           (paste it into the key dialog, bottom-left; stored in .lh-harness/web-token)`);
  print(`Stop:      docker stop ${name}    Logs: docker logs -f ${name}`);
  if (!ready) {
    eprint(`The workbench did not answer within 30s; check \`docker logs ${name}\`.`);
    return 1;
  }
  if (!noOpen) void openBrowserWhenReady(url);
  return 0;
}

export function publicRoleConfigsFromArgs(
  args: Namespace,
): Record<string, Record<string, string>> | null {
  const publicRoles = ["manager", "executor", "auditor"] as const;
  const overridden = publicRoles.some((role) =>
    ["agent", "model", "reasoning_effort"].some((field) => Boolean(args[`${role}_${field}`])),
  );
  if (!overridden) return null;
  const defaults: Record<string, string> = { claude_code: DEFAULT_CLAUDE_MODEL };
  const result: Record<string, Record<string, string>> = {};
  for (const role of publicRoles) {
    const roleAgent = resolveRoleOption(args, role, "agent") ?? String(args["agent"]);
    const effort = resolveRoleReasoningEffort(args, role, roleAgent);
    const entry: Record<string, string> = {
      agent: roleAgent,
      model: resolveRoleModel(args, role) ?? (defaults[roleAgent] as string),
    };
    // Only recorded when set: absence means "follow the provider".
    if (effort) entry["reasoning_effort"] = effort;
    result[role] = entry;
  }
  return result;
}

/** Persist a terminal report when agent construction fails before Manager. */
export function writeBootstrapFailure(
  logDir: string,
  task: string,
  exc: unknown,
  maxRounds: number,
): void {
  const roleDir = path.join(logDir, "role_orchestration");
  const trace = exc instanceof Error ? (exc.stack ?? String(exc)) : String(exc);
  const report = {
    schema_version: 2,
    status: "failed",
    task,
    completion_satisfied: false,
    completion_authority: "manager_with_role_auditors",
    rounds_run: 0,
    max_rounds: maxRounds,
    abort_reason: "worker_bootstrap_failure",
    error: _text(exc),
    exception_type: exc instanceof Error ? exc.name : typeof exc,
    traceback_tail: trace.slice(Math.max(0, trace.length - 12000)),
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  for (const target of [path.join(logDir, "report.json"), path.join(roleDir, "report.json")]) {
    try {
      _atomicBytesWrite(target, Buffer.from(encoded, "utf-8"));
    } catch {
      /* the role directory may be a symlink; the real report still lands */
    }
  }
  try {
    _appendJsonlNofollow(path.join(roleDir, "events.jsonl"), {
      schema_version: 1,
      event: "role_harness_failed",
      status: "failed",
      ts: Date.now() / 1000,
      reason: _text(exc),
      exception_type: exc instanceof Error ? exc.name : typeof exc,
      traceback_tail: trace.slice(Math.max(0, trace.length - 4000)),
    });
  } catch {
    /* best effort */
  }
}

/**
 * Read only the supervisor's reserved `tmp/task.md` contract.
 *
 * `readTask` deliberately supports arbitrary `@path` values for the public CLI.
 * A supervised worker is different: its command is generated by the supervisor
 * and must never become a confused-deputy file reader if someone invokes the
 * hidden flag manually or tampers with its argv.
 */
export function readSupervisedTask(raw: string, runDir: string): string {
  if (!raw.startsWith("@")) throw new Error("supervised workers require a @task-file reference");
  const expected = path.resolve(runDir, "tmp", "task.md");
  const supplied = path.resolve(expandUser(raw.slice(1)));
  if (supplied !== expected) {
    throw new Error("supervised task file must be the reserved run/tmp/task.md");
  }
  return readTask(raw);
}

export function readTask(raw: string): string {
  if (!raw.startsWith("@")) return raw;
  const target = expandUser(raw.slice(1));
  let fd: number | null = null;
  try {
    // Supervisor-created task files live below a worker-writable run tree. Read
    // through an anchored descriptor so a replacement of ``tmp`` or ``task.md``
    // between launch and bootstrap cannot make the worker consume a different
    // file (or an external secret).
    fd = _openNofollow(target);
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("task file is not a private regular file");
    }
    if (metadata.size > _MAX_TASK_FILE_BYTES) throw new Error("task file is too large");
    const buffer = Buffer.alloc(_MAX_TASK_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, total, _MAX_TASK_FILE_BYTES + 1 - total, null);
      if (read <= 0) break;
      total += read;
      if (total >= _MAX_TASK_FILE_BYTES + 1) break;
    }
    if (total > _MAX_TASK_FILE_BYTES) throw new Error("task file is too large");
    return pyStrip(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export async function buildEnv(spec: string, tmpDir: string | null = null): Promise<Environment> {
  if (spec === "local") {
    const { LocalEnvironment } = await import("./environment/local.js");
    return new LocalEnvironment(tmpDir);
  }
  throw new Error(`Unknown env: ${spec}`);
}

export async function buildAgent(
  name: string,
  options: {
    role: string;
    model: string | null;
    apiKey: string | null;
    baseUrl: string | null;
    workspacePath: string;
    promptDir: string;
    mcpConfig?: string | null;
    mcpAddDirs?: string[] | null;
    hiddenPaths?: readonly string[];
    guardExcludePaths?: readonly string[];
    reasoningEffort?: string | null;
  },
): Promise<AgentAdapter> {
  if (name === "claude_code") {
    const { ClaudeCodeAdapter } = await import("./adapters/claude_code.js");

    const kwargs: Record<string, unknown> = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      workspacePath: options.workspacePath,
      promptDir: options.promptDir,
      mcpConfig: options.mcpConfig ?? null,
      addDirs: options.mcpAddDirs ?? null,
      role: options.role,
      hiddenPaths: options.hiddenPaths ?? [],
      guardExcludePaths: options.guardExcludePaths ?? [],
      reasoningEffort: options.reasoningEffort ?? null,
    };
    if (options.model !== null && options.model !== undefined) kwargs["model"] = options.model;
    return new ClaudeCodeAdapter(kwargs as never) as unknown as AgentAdapter;
  }
  throw new Error(`Unknown agent: ${name}`);
}

// ---------------------------------------------------------------------------
// entry point (`__main__.py`)
// ---------------------------------------------------------------------------

const _invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (_invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    const timer = setTimeout(() => process.exit(code), 0);
    if (typeof timer.unref === "function") timer.unref();
  });
}
