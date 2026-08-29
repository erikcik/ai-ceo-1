// Subagents every role may spawn through the Agent tool. They are defined in
// code (not in the workspace) so a run cannot be steered by a stray
// `.claude/agents/` folder, and so the operator can read what each one does.

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

const RESEARCH_TOOLS = ["WebSearch", "WebFetch", "Read", "Glob", "Grep"];

export interface SubagentContext {
  memoryDir: string;
  sourcesDir: string;
  stateDir: string;
  /** Model alias for cheaper research fan-out ("sonnet" by default). */
  researchModel?: string;
}

export function loopSubagents(context: SubagentContext): Record<string, AgentDefinition> {
  const model = context.researchModel ?? "sonnet";
  return {
    "web-researcher": {
      description:
        "Answers one precise research question from the web with sources whose authors are credible in the domain. Use many in parallel, one question each.",
      model,
      tools: RESEARCH_TOOLS,
      prompt: [
        "You research ONE question thoroughly and report findings the caller can act on.",
        "Method: search broadly first, then open the 3-8 most promising pages. Prefer primary sources (official docs, platform specs, the brand's own site, peer-reviewed or practitioner-authored material) over aggregators and content farms.",
        "For every source you rely on, state who wrote/published it and why that author or entity is credible in this domain (track record, official status, expertise). Drop sources whose credibility you cannot establish.",
        "Report format: `## Answer` (direct, concrete, with numbers/specs where they exist), `## Evidence` (bullets: claim → source URL → author/entity credibility), `## Uncertainty` (what you could not confirm). Under 600 words. Do not pad.",
      ].join("\n\n"),
    },
    "memory-curator": {
      description:
        "Finds and summarises the memory-wiki pages relevant to a topic. Use when you want lessons from earlier runs.",
      model,
      tools: ["Read", "Glob", "Grep"],
      prompt: [
        `The memory wiki lives at ${context.memoryDir} (index.md lists every page; log.md is the change log).`,
        "Given a topic, read index.md, open every page that could apply, and return: `## Relevant pages` (file, one-line why), `## What to apply` (concrete lessons, quoted where useful), `## Gaps` (what the wiki does not cover). If nothing applies, say so in one line.",
      ].join("\n\n"),
    },
    "rubric-researcher": {
      description:
        "Collects how experts grade a given kind of deliverable: standards, specs, rubric examples, and what separates excellent from generic work.",
      model,
      tools: RESEARCH_TOOLS,
      prompt: [
        `Operator-provided reference material (rubric examples, standards) may exist under ${context.sourcesDir}; read anything relevant there first, then the web.`,
        "Given a deliverable type and audience, return `## Criteria` — each as: statement, how to verify it by inspection, what evidence a producer should leave, whether failing it makes the deliverable unusable, and the source (URL or file) with the author's credibility. Include both hard requirements (specs, platform rules) and quality dimensions (originality, craft, fit for audience) with a description of what a weak (2/5) and an excellent (5/5) result looks like. Under 700 words.",
      ].join("\n\n"),
    },
    "evaluation-researcher": {
      description:
        "Learns how the best reviewers in a domain inspect a deliverable: what they check first, what they refuse, which measurable standards apply.",
      model,
      tools: RESEARCH_TOOLS,
      prompt: [
        `Planner research notes are under ${context.stateDir}/research and operator sources under ${context.sourcesDir}; use them alongside the web.`,
        "Given a deliverable type, return `## Inspection checklist` (ordered: what an expert reviewer opens/measures first, with the exact tool or method), `## Automatic rejections` (defects that fail the work regardless of the rest), `## Quality signals` (what distinguishes excellent from acceptable, observable), and `## Sources` with author credibility. Under 600 words.",
      ].join("\n\n"),
    },
  };
}
