// A realistic snapshot for `?demo=1`.
//
// It exists so the workbench can be reviewed without a backend: a three-level
// plan, one leaf mid-composition, one leaf that needed two evaluation rounds,
// contracts, context packs, evidence, episodes and a pending human gate.
// Nothing here is fetched, so state-file links degrade to their empty states.

import type {
  Contract,
  EpisodeIndexEntry,
  LedgerEntry,
  EvaluationRecord,
  EventEnvelope,
  Plan,
  PlanNode,
  PlanRevisionEntry,
  RunSummary,
  Snapshot,
  SubtaskView,
} from '../../../core/src/types';

const NOW = 1_756_000_000;

function node(id: string, title: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    title,
    goal: '',
    rationale: '',
    backing: [],
    constraints: [],
    deliverables: [],
    acceptance: [],
    depends_on: [],
    children: [],
    status: 'pending',
    rounds: 0,
    last_verdict: null,
    added_by: 'planner',
    note: '',
    ...extra,
  };
}

const PLAN: Plan = {
  schema_version: 1,
  title: 'Ship the vendor comparison page',
  summary: 'Research three competing vendors, write a comparison page, prove it renders, then publish it.',
  assumptions: [
    'The marketing site is the Next.js app in `web/`.',
    'Pricing is public for all three vendors.',
  ],
  questions: ['Should the page link to our own pricing, or stay neutral?'],
  revision: 3,
  created_at: NOW - 3600,
  updated_at: NOW - 60,
  nodes: [
    node('research-vendors', 'Research the vendors', {
      goal: 'Know what each vendor actually charges and promises.',
      rationale: 'A comparison written from memory is the fastest way to publish something wrong.',
      backing: [
        { kind: 'reasoning', ref: 'The task names three vendors but gives no numbers.', note: '' },
      ],
      status: 'done',
      children: [
        node('collect-sources', 'Collect primary sources', {
          goal: 'Gather the vendor documentation and pricing pages we will cite.',
          status: 'done',
          children: [
            node('search-vendor-docs', 'Search the vendor docs', {
              goal: 'Find the current feature documentation for each vendor.',
              rationale: 'Feature claims must come from the vendor, not from a blog post.',
              backing: [{ kind: 'web', ref: 'https://example.test/vendor-a/docs', note: 'Vendor A documentation root' }],
              deliverables: ['A note listing the doc URL per vendor'],
              acceptance: ['Three vendors, three live documentation URLs'],
              status: 'done',
              rounds: 1,
              last_verdict: 'PASS',
            }),
            node('read-pricing-pages', 'Read the pricing pages', {
              goal: 'Record each vendor’s published price for the entry tier.',
              backing: [
                { kind: 'web', ref: 'https://example.test/vendor-b/pricing', note: 'Vendor B pricing' },
                { kind: 'memory', ref: 'notes/2026-q2-pricing.md', note: 'Last quarter’s numbers, for comparison' },
              ],
              deliverables: ['A price table with one row per vendor'],
              acceptance: ['Every price cites the page it came from'],
              status: 'done',
              rounds: 1,
              last_verdict: 'PASS',
            }),
          ],
        }),
        node('summarise-findings', 'Summarise the findings', {
          goal: 'Turn the raw sources into a one-page brief the writer can use.',
          rationale: 'The composer for the copy should not have to re-read every source.',
          backing: [{ kind: 'source', ref: 'state/research/vendors.md', note: 'The planner’s own research note' }],
          depends_on: ['search-vendor-docs', 'read-pricing-pages'],
          deliverables: ['state/progress/summarise-findings.md'],
          acceptance: ['Covers all three vendors', 'No claim without a source'],
          status: 'done',
          rounds: 1,
          last_verdict: 'PASS',
        }),
      ],
    }),
    node('build-page', 'Build the comparison page', {
      goal: 'A page that renders the comparison and passes review.',
      rationale: 'This is the deliverable the task actually asks for.',
      status: 'composing',
      children: [
        node('draft-copy', 'Draft the copy', {
          goal: 'Write neutral comparison copy backed by the research brief.',
          rationale: 'Copy first: the layout follows the text, not the other way round.',
          backing: [
            { kind: 'source', ref: 'state/progress/summarise-findings.md', note: 'The research brief' },
            { kind: 'reasoning', ref: 'Neutral tone was an explicit constraint in the task.', note: '' },
          ],
          constraints: ['No superlatives', 'Do not name our own product as the winner'],
          deliverables: ['web/content/comparison.mdx'],
          acceptance: ['Every claim traces to a cited source', 'Under 700 words'],
          depends_on: ['summarise-findings'],
          status: 'done',
          rounds: 2,
          last_verdict: 'PASS',
        }),
        node('implement-page', 'Implement the page', {
          goal: 'Render the copy as a responsive comparison table at /compare.',
          rationale: 'The copy is useless until it is a page a visitor can open.',
          backing: [{ kind: 'source', ref: 'web/app/compare/page.tsx', note: 'Where the route lives' }],
          constraints: ['Reuse the existing table component', 'No new npm dependencies'],
          deliverables: ['web/app/compare/page.tsx'],
          acceptance: ['`npm run build` passes', 'The table is readable at 375px wide'],
          depends_on: ['draft-copy'],
          status: 'composing',
          rounds: 1,
          last_verdict: 'NEEDS_WORK',
          note: 'Second attempt after the mobile layout finding.',
        }),
        node('screenshot-proof', 'Capture proof screenshots', {
          goal: 'Prove the page renders at desktop and mobile widths.',
          rationale: 'The evaluator cannot open a browser; a screenshot is the evidence.',
          deliverables: ['state/evidence/screenshot-proof/desktop.png'],
          acceptance: ['One screenshot per breakpoint'],
          depends_on: ['implement-page'],
          status: 'pending',
          added_by: 'evaluator:implement-page',
        }),
      ],
    }),
    node('publish', 'Publish the page', {
      goal: 'Merge and deploy the comparison page.',
      rationale: 'The task is not done until the page is live.',
      constraints: ['Do not deploy without the screenshots'],
      deliverables: ['A deployment URL'],
      acceptance: ['The live URL returns 200'],
      depends_on: ['screenshot-proof'],
      status: 'pending',
    }),
  ],
};

function contract(subtaskId: string, criteria: Array<Partial<Contract['criteria'][number]> & { id: string; statement: string }>): Contract {
  return {
    subtask_id: subtaskId,
    criteria: criteria.map((item) => ({
      verify: '',
      evidence: '',
      mandatory: false,
      weight: 1,
      passes: false,
      score: null,
      finding: '',
      ...item,
    })),
    scoring: { scale: '0-5 per quality criterion', pass_rule: 'all mandatory criteria pass and the weighted mean score is at least 3.5' },
    created_at: NOW - 1800,
    updated_at: NOW - 120,
  };
}

const DRAFT_COPY_EVALUATIONS: EvaluationRecord[] = [
  {
    subtask_id: 'draft-copy',
    round: 1,
    verdict: 'NEEDS_WORK',
    claimed_verdict: 'NEEDS_WORK',
    summary: 'The copy reads well but two pricing claims have no citation, and it is 60 words over the limit.',
    criteria: [
      { id: 'cited', passes: false, score: 2, checked: ['Counted 7 claims, 5 citations'], finding: 'Vendor C pricing and the "fastest onboarding" claim are uncited.' },
      { id: 'neutral', passes: true, score: 4, checked: ['No superlatives found'], finding: '' },
      { id: 'length', passes: false, score: 3, checked: ['wc -w → 758'], finding: '758 words against a 700 limit.' },
    ],
    findings: [
      'Cite the Vendor C pricing page for the $29 figure, or drop the figure.',
      'Remove the onboarding-speed claim; nothing in the brief supports it.',
      'Cut roughly 60 words, ideally from the intro.',
    ],
    plan_changes: [],
    memory_notes: ['The brief has no onboarding data; do not invent it later.'],
    narrative: 'I read `web/content/comparison.mdx` end to end and cross-checked every factual sentence against `state/progress/summarise-findings.md`.\n\nThe tone is right. The problem is sourcing.',
    harness_note: '',
    episode_dir: '/runs/demo/evaluator_episodes/ep005',
    created_at: NOW - 1500,
  },
  {
    subtask_id: 'draft-copy',
    round: 2,
    verdict: 'PASS',
    claimed_verdict: 'PASS',
    summary: 'Both uncited claims are gone and the piece is 640 words. Accepting.',
    criteria: [
      { id: 'cited', passes: true, score: 5, checked: ['7 claims, 7 citations'], finding: '' },
      { id: 'neutral', passes: true, score: 4, checked: ['No superlatives found'], finding: '' },
      { id: 'length', passes: true, score: 5, checked: ['wc -w → 640'], finding: '' },
    ],
    findings: [],
    plan_changes: [],
    memory_notes: [],
    narrative: 'Re-read the file and diffed it against round 1.',
    harness_note: '',
    episode_dir: '/runs/demo/evaluator_episodes/ep007',
    created_at: NOW - 900,
  },
];

const IMPLEMENT_EVALUATIONS: EvaluationRecord[] = [
  {
    subtask_id: 'implement-page',
    round: 1,
    verdict: 'NEEDS_WORK',
    claimed_verdict: 'PASS',
    summary: 'The build passes, but the table overflows below 420px, which the contract makes mandatory.',
    criteria: [
      { id: 'builds', passes: true, score: 5, checked: ['npm run build → exit 0'], finding: '' },
      { id: 'responsive', passes: false, score: 1, checked: ['Rendered at 375px'], finding: 'The table scrolls the page body horizontally.' },
      { id: 'no-new-deps', passes: true, score: 5, checked: ['package.json unchanged'], finding: '' },
    ],
    findings: ['Wrap the table in a container with `overflow-x: auto` instead of letting the body scroll.'],
    plan_changes: [{ op: 'add', parent_id: 'build-page', node: { title: 'Capture proof screenshots', id: 'screenshot-proof' }, reason: 'The responsive claim needs visual proof next time.' }],
    memory_notes: [],
    narrative: 'Ran the build, then rendered the route at three widths.',
    harness_note: 'evaluator said PASS but the contract rule fails: mandatory criteria failed: responsive',
    episode_dir: '/runs/demo/evaluator_episodes/ep009',
    created_at: NOW - 300,
  },
];

const EPISODES: EpisodeIndexEntry[] = [
  { seq: 1, ep: 1, role: 'prompt_tailor', subtask_id: null, round: null, dir: '/runs/demo/prompt_tailor_episodes/ep001', status: 'done', started_at: NOW - 3600, finished_at: NOW - 3570, duration_ms: 30_000, cost_usd: 0.02, error: null },
  { seq: 2, ep: 1, role: 'planner', subtask_id: null, round: null, dir: '/runs/demo/planner_episodes/ep001', status: 'done', started_at: NOW - 3560, finished_at: NOW - 3400, duration_ms: 160_000, cost_usd: 0.41, error: null },
  { seq: 3, ep: 1, role: 'rubric', subtask_id: 'draft-copy', round: null, dir: '/runs/demo/rubric_episodes/ep001', status: 'done', started_at: NOW - 2000, finished_at: NOW - 1960, duration_ms: 40_000, cost_usd: 0.05, error: null },
  { seq: 4, ep: 1, role: 'composer', subtask_id: 'draft-copy', round: 1, dir: '/runs/demo/composer_episodes/ep001', status: 'done', started_at: NOW - 1950, finished_at: NOW - 1600, duration_ms: 350_000, cost_usd: 0.88, error: null },
  { seq: 5, ep: 1, role: 'evaluator', subtask_id: 'draft-copy', round: 1, dir: '/runs/demo/evaluator_episodes/ep001', status: 'done', started_at: NOW - 1590, finished_at: NOW - 1500, duration_ms: 90_000, cost_usd: 0.19, error: null },
  { seq: 6, ep: 2, role: 'composer', subtask_id: 'draft-copy', round: 2, dir: '/runs/demo/composer_episodes/ep002', status: 'done', started_at: NOW - 1490, finished_at: NOW - 1000, duration_ms: 490_000, cost_usd: 0.94, error: null },
  { seq: 7, ep: 2, role: 'evaluator', subtask_id: 'draft-copy', round: 2, dir: '/runs/demo/evaluator_episodes/ep002', status: 'done', started_at: NOW - 990, finished_at: NOW - 900, duration_ms: 90_000, cost_usd: 0.21, error: null },
  { seq: 8, ep: 3, role: 'composer', subtask_id: 'implement-page', round: 1, dir: '/runs/demo/composer_episodes/ep003', status: 'done', started_at: NOW - 880, finished_at: NOW - 320, duration_ms: 560_000, cost_usd: 1.32, error: null },
  { seq: 9, ep: 3, role: 'evaluator', subtask_id: 'implement-page', round: 1, dir: '/runs/demo/evaluator_episodes/ep003', status: 'done', started_at: NOW - 310, finished_at: NOW - 300, duration_ms: 10_000, cost_usd: 0.24, error: null },
  { seq: 10, ep: 4, role: 'composer', subtask_id: 'implement-page', round: 2, dir: '/runs/demo/composer_episodes/ep004', status: 'running', started_at: NOW - 90, finished_at: null, duration_ms: null, cost_usd: null, error: null },
];

const DRAFT_COPY_LEDGER: LedgerEntry[] = [
  { ts: NOW - 1900, subtask: 'draft-copy', round: 1, kind: 'write', tool: 'Write', path: 'web/content/comparison.mdx', sha256_before: null, sha256_after: 'a91f', bytes: 4_820 },
  { ts: NOW - 1860, subtask: 'draft-copy', round: 1, kind: 'bash', tool: 'Bash', command: 'wc -w web/content/comparison.mdx' },
  { ts: NOW - 1420, subtask: 'draft-copy', round: 2, kind: 'write', tool: 'Edit', path: 'web/content/comparison.mdx', sha256_before: 'a91f', sha256_after: 'c40b', bytes: 4_120 },
  { ts: NOW - 1400, subtask: 'draft-copy', round: 2, kind: 'bash', tool: 'Bash', command: 'wc -w web/content/comparison.mdx' },
  { ts: NOW - 1050, subtask: 'draft-copy', round: 2, kind: 'write', tool: 'Write', path: 'state/evidence/draft-copy/wordcount.txt', sha256_before: null, sha256_after: '77de', bytes: 12 },
];

const IMPLEMENT_LEDGER: LedgerEntry[] = [
  { ts: NOW - 850, subtask: 'implement-page', round: 1, kind: 'write', tool: 'Write', path: 'web/app/compare/page.tsx', sha256_before: null, sha256_after: '1b7c', bytes: 3_180 },
  { ts: NOW - 700, subtask: 'implement-page', round: 1, kind: 'bash', tool: 'Bash', command: 'npm run build' },
  { ts: NOW - 420, subtask: 'implement-page', round: 1, kind: 'write', tool: 'Edit', path: 'web/app/compare/compare.module.css', sha256_before: '55aa', sha256_after: '90f1', bytes: 1_260 },
  { ts: NOW - 60, subtask: 'implement-page', round: 2, kind: 'bash', tool: 'Bash', command: 'npm run build && node scripts/shoot.mjs --width 375' },
];

const PLAN_REVISIONS: PlanRevisionEntry[] = [
  { revision: 0, note: 'initial plan', written_at: NOW - 3400 },
  { revision: 1, note: 'planner answered the operator question about neutrality', written_at: NOW - 2100 },
  { revision: 2, note: 'evaluator:draft-copy tightened the acceptance wording', written_at: NOW - 1480 },
  { revision: 3, note: 'evaluator:implement-page added screenshot-proof', written_at: NOW - 295 },
];

function simpleSubtask(id: string, title: string, extra: Partial<SubtaskView> = {}): SubtaskView {
  return {
    id,
    title,
    status: 'done',
    rounds: 1,
    last_verdict: 'PASS',
    contract: null,
    rubric: '',
    progress: '',
    evidence_files: [],
    evidence_meta: [],
    ledger_count: 0,
    ledger: [],
    evaluations: [],
    context: [],
    episodes: [],
    ...extra,
  };
}

const SUBTASKS: SubtaskView[] = [
  simpleSubtask('search-vendor-docs', 'Search the vendor docs', {
    progress: 'Found the documentation root for all three vendors and recorded the URLs in the research note.',
    contract: contract('search-vendor-docs', [
      { id: 'three-vendors', statement: 'A documentation URL is recorded for each of the three vendors.', mandatory: true, passes: true, score: 5, verify: 'Read the research note' },
    ]),
    ledger_count: 3,
  }),
  simpleSubtask('read-pricing-pages', 'Read the pricing pages', {
    progress: 'Recorded the entry-tier price for each vendor with the page it came from.',
    contract: contract('read-pricing-pages', [
      { id: 'sourced', statement: 'Every price cites the pricing page it was read from.', mandatory: true, passes: true, score: 5 },
    ]),
    evidence_files: ['pricing-table.md'],
    evidence_meta: [{ name: 'pricing-table.md', bytes: 1_840 }],
    ledger_count: 4,
    ledger: [
      { ts: NOW - 2600, subtask: 'read-pricing-pages', round: 1, kind: 'write', tool: 'Write', path: 'state/evidence/read-pricing-pages/pricing-table.md', sha256_before: null, sha256_after: '2f10', bytes: 1_840 },
      { ts: NOW - 2580, subtask: 'read-pricing-pages', round: 1, kind: 'bash', tool: 'Bash', command: 'cat state/evidence/read-pricing-pages/pricing-table.md' },
    ],
  }),
  simpleSubtask('summarise-findings', 'Summarise the findings', {
    progress: '# Vendor brief\n\nThree vendors, one table, every row sourced.\n\n- **Vendor A** — $19/mo entry tier.\n- **Vendor B** — $29/mo entry tier.\n- **Vendor C** — usage-based, no fixed entry tier.',
    contract: contract('summarise-findings', [
      { id: 'covers-all', statement: 'All three vendors appear in the brief.', mandatory: true, passes: true, score: 5 },
      { id: 'sourced', statement: 'No claim appears without a source.', mandatory: true, passes: true, score: 4 },
    ]),
    ledger_count: 2,
  }),
  {
    id: 'draft-copy',
    title: 'Draft the copy',
    status: 'done',
    rounds: 2,
    last_verdict: 'PASS',
    contract: contract('draft-copy', [
      { id: 'cited', statement: 'Every factual claim traces to a source in the research brief.', mandatory: true, weight: 2, passes: true, score: 5, verify: 'Count claims against citations', evidence: 'The rendered copy' },
      { id: 'neutral', statement: 'The copy names no winner and uses no superlatives.', mandatory: true, passes: true, score: 4, verify: 'Read for tone' },
      { id: 'length', statement: 'The copy is under 700 words.', mandatory: false, passes: true, score: 5, verify: 'wc -w' },
    ]),
    rubric: '# Rubric — draft the copy\n\nThe copy is a *comparison*, not a pitch. Judge it on sourcing first and prose second.\n\n1. **Sourcing.** Every number and every capability claim must appear in `state/progress/summarise-findings.md`. An uncited claim fails this criterion outright, regardless of whether it is true.\n2. **Neutrality.** No superlatives, no ranking, no recommendation.\n3. **Length.** Under 700 words. This one is advisory: score it, do not block on it.',
    progress: 'Rewrote the intro after round 1. Dropped the onboarding-speed claim entirely (nothing in the brief supports it) and cited the Vendor C pricing page for the $29 figure. Final length is 640 words.',
    evidence_files: ['comparison.mdx', 'wordcount.txt'],
    evidence_meta: [{ name: 'comparison.mdx', bytes: 4_120 }, { name: 'wordcount.txt', bytes: 12 }],
    ledger_count: 6,
    ledger: DRAFT_COPY_LEDGER,
    evaluations: DRAFT_COPY_EVALUATIONS,
    context: [
      {
        round: 1,
        selector: 'python:context_selector',
        sections: [
          { title: 'Task', kind: 'task', path: 'state/task/TASK.md', reason: 'Always included', chars: 412 },
          { title: 'Subtask brief', kind: 'plan', path: 'state/plan/PLAN.md', reason: 'The node being worked on, plus its ancestors', chars: 980 },
          { title: 'Research brief', kind: 'progress', path: 'state/progress/summarise-findings.md', reason: 'Declared as a dependency of this subtask', chars: 2_140 },
          { title: 'Contract', kind: 'contract', path: 'state/contracts/draft-copy.json', reason: 'The composer must know what it is judged against', chars: 760 },
        ],
      },
      {
        round: 2,
        selector: 'python:context_selector',
        sections: [
          { title: 'Task', kind: 'task', path: 'state/task/TASK.md', reason: 'Always included', chars: 412 },
          { title: 'Round 1 evaluation', kind: 'evaluation', path: 'state/evaluations/draft-copy/r1.md', reason: 'The findings the composer must address', chars: 1_310 },
          { title: 'Previous draft', kind: 'evidence', path: 'state/evidence/draft-copy/comparison.mdx', reason: 'The artefact being revised', chars: 4_820 },
          { title: 'Contract', kind: 'contract', path: 'state/contracts/draft-copy.json', reason: 'The composer must know what it is judged against', chars: 760 },
        ],
      },
    ],
    episodes: EPISODES.filter((entry) => entry.subtask_id === 'draft-copy'),
  },
  {
    id: 'implement-page',
    title: 'Implement the page',
    status: 'composing',
    rounds: 1,
    last_verdict: 'NEEDS_WORK',
    contract: contract('implement-page', [
      { id: 'builds', statement: '`npm run build` exits 0 with the new route in place.', mandatory: true, weight: 2, passes: true, score: 5, verify: 'Run the build', evidence: 'Build log' },
      { id: 'responsive', statement: 'The comparison table is readable at 375px without scrolling the page body.', mandatory: true, weight: 2, passes: false, score: 1, verify: 'Render at 375px', evidence: 'Screenshot', finding: 'The table scrolls the page body horizontally.' },
      { id: 'no-new-deps', statement: 'No dependency was added to package.json.', mandatory: true, passes: true, score: 5, verify: 'git diff package.json' },
    ]),
    rubric: '# Rubric — implement the page\n\nThis subtask is judged on the *rendered result*, not on the diff.\n\n- The build must pass. A failing build is an automatic NEEDS_WORK.\n- The table must be usable on a phone. Horizontal scrolling of the page body is a failure; scrolling inside the table container is fine.\n- No new dependencies. The existing table component is sufficient.',
    progress: 'Round 1 shipped the route and the table but let the body scroll on narrow viewports. Currently wrapping the table in an `overflow-x: auto` container and re-checking at 375px, 768px and 1280px.',
    evidence_files: ['build.log', 'mobile-375.png', 'desktop-1280.png', 'walkthrough.mp4'],
    evidence_meta: [
      { name: 'build.log', bytes: 34_120 },
      { name: 'mobile-375.png', bytes: 184_300 },
      { name: 'desktop-1280.png', bytes: 402_880 },
      { name: 'walkthrough.mp4', bytes: 41_900_000 },
    ],
    ledger_count: 5,
    ledger: IMPLEMENT_LEDGER,
    evaluations: IMPLEMENT_EVALUATIONS,
    context: [
      {
        round: 1,
        selector: 'python:context_selector',
        sections: [
          { title: 'Task', kind: 'task', path: 'state/task/TASK.md', reason: 'Always included', chars: 412 },
          { title: 'Accepted copy', kind: 'evidence', path: 'state/evidence/draft-copy/comparison.mdx', reason: 'The content this page must render', chars: 4_120 },
          { title: 'Existing route', kind: 'source', path: 'web/app/compare/page.tsx', reason: 'Named in the node backing', chars: 1_890 },
          { title: 'Contract', kind: 'contract', path: 'state/contracts/implement-page.json', reason: 'The composer must know what it is judged against', chars: 840 },
        ],
      },
    ],
    episodes: EPISODES.filter((entry) => entry.subtask_id === 'implement-page'),
  },
  simpleSubtask('screenshot-proof', 'Capture proof screenshots', { status: 'pending', rounds: 0, last_verdict: null }),
  simpleSubtask('publish', 'Publish the page', { status: 'pending', rounds: 0, last_verdict: null }),
];

function event(id: string, type: string, ts: number, payload: Record<string, unknown> = {}, role: string | null = null): EventEnvelope {
  return {
    schema_version: 1,
    event_id: id,
    type,
    ts,
    run_id: 'demo-run',
    round: typeof payload.round === 'number' ? payload.round : null,
    role,
    status: type.endsWith('.started') ? 'running' : 'completed',
    payload,
    legacy: {},
  };
}

const EVENTS: EventEnvelope[] = [
  event('ev-1', 'run.started', NOW - 3600, { task: 'Ship the vendor comparison page' }),
  event('ev-2', 'phase.started', NOW - 3600, { phase: 'tailoring' }),
  event('ev-3', 'tailor.completed', NOW - 3570, { roles: ['planner', 'rubric', 'composer', 'evaluator'] }, 'prompt_tailor'),
  event('ev-4', 'phase.started', NOW - 3560, { phase: 'planning' }),
  event('ev-5', 'plan.written', NOW - 3400, { nodes: 10, leaves: 7 }, 'planner'),
  event('ev-6', 'phase.started', NOW - 3390, { phase: 'executing' }),
  event('ev-7', 'subtask.started', NOW - 2000, { subtask_id: 'draft-copy' }),
  event('ev-8', 'rubric.written', NOW - 1960, { subtask_id: 'draft-copy', criteria: 3 }, 'rubric'),
  event('ev-9', 'context.selected', NOW - 1950, { subtask_id: 'draft-copy', round: 1, sections: 4 }),
  event('ev-10', 'composer.completed', NOW - 1600, { subtask_id: 'draft-copy', round: 1 }, 'composer'),
  event('ev-11', 'evaluation.recorded', NOW - 1500, { subtask_id: 'draft-copy', round: 1, verdict: 'NEEDS_WORK' }, 'evaluator'),
  event('ev-12', 'composer.completed', NOW - 1000, { subtask_id: 'draft-copy', round: 2 }, 'composer'),
  event('ev-13', 'evaluation.recorded', NOW - 900, { subtask_id: 'draft-copy', round: 2, verdict: 'PASS' }, 'evaluator'),
  event('ev-14', 'subtask.completed', NOW - 890, { subtask_id: 'draft-copy' }),
  event('ev-15', 'subtask.started', NOW - 880, { subtask_id: 'implement-page' }),
  event('ev-16', 'composer.completed', NOW - 320, { subtask_id: 'implement-page', round: 1 }, 'composer'),
  event('ev-17', 'evaluation.recorded', NOW - 300, { subtask_id: 'implement-page', round: 1, verdict: 'NEEDS_WORK' }, 'evaluator'),
  event('ev-18', 'plan.revised', NOW - 295, { revision: 3, added: ['screenshot-proof'] }, 'evaluator'),
  event('ev-19', 'operator.gate.opened', NOW - 290, { trigger: 'needs_human', subtask_id: 'implement-page' }),
  event('ev-20', 'episode.started', NOW - 90, { subtask_id: 'implement-page', round: 2 }, 'composer'),
];

export const DEMO_SNAPSHOT: Snapshot = {
  schema_version: 2,
  run: {
    id: 'demo-run',
    status: 'waiting_approval',
    started_at: NOW - 3600,
    finished_at: null,
    log_dir: '/runs/demo',
    completion_satisfied: null,
    completion_authority: null,
    report_status: null,
    exit_code: null,
    failure_reason: null,
    final_response: '',
    cost_usd: 4.26,
    rounds_run: 4,
    agent: 'claude_code',
    model: 'claude-opus-5',
    role_configs: {
      planner: { agent: 'claude_code', model: 'claude-opus-5' },
      composer: { agent: 'claude_code', model: 'claude-opus-5' },
      evaluator: { agent: 'codex', model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    },
    workspace: '/Users/demo/work/site',
    max_rounds: 25,
    prompt_language: 'en',
  },
  mission: {
    task: 'Ship a neutral vendor comparison page on the marketing site, with proof that it renders on mobile.',
    plan_path: 'plan/plan.json',
    report_path: 'report.json',
  },
  loop: {
    phase: {
      phase: 'executing',
      current_subtask: 'implement-page',
      current_role: 'composer',
      current_round: 2,
      updated_at: NOW - 90,
      detail: 'composing implement-page (round 2 of the composer↔evaluator loop)',
    },
    task: 'Ship a neutral vendor comparison page on the marketing site, with proof that it renders on mobile.',
    config: { max_rounds: 25, max_eval_rounds: 3, min_research_agents: 2, research_model: 'claude-opus-5' },
    plan: PLAN,
    plan_markdown: '',
    plan_revisions: PLAN_REVISIONS,
    status_counts: { pending: 2, rubric: 0, composing: 1, evaluating: 0, done: 4, blocked: 0, skipped: 0 },
    briefings: {
      planner: '# Planner briefing\n\nYou are planning a small marketing-site change. Prefer three to eight leaves; a leaf is one composer sitting.\n\nCite something for every node: a URL, a repository path, or an explicit line of reasoning.',
      rubric: '# Rubric briefing\n\nWrite criteria that default to FAIL. A criterion that a composer can satisfy by claiming success is not a criterion.',
      composer: '# Composer briefing\n\nDo the work, then leave proof. Screenshots for anything visual, command output for anything that runs.',
      evaluator: '# Evaluator briefing\n\nGrade the contract, not your impression. If a mandatory criterion fails, the verdict is NEEDS_WORK even if everything else is excellent.',
    },
    research: ['vendors.md', 'pricing-2026-q3.md'],
    research_notes: [
      { file: 'vendors.md', title: 'Vendor capability matrix' },
      { file: 'pricing-2026-q3.md', title: 'Published pricing, Q3 2026' },
    ],
    subtasks: SUBTASKS,
    episodes: EPISODES,
    cost_usd: 4.26,
    composer_episodes: 3,
    decisions: '# Operator decisions\n\n- **NOW-1700** — "Keep the tone neutral — this page must not read as an ad." (queued instruction, applied before round 2 of `draft-copy`)\n- **NOW-290** — gate `needs_human` on `implement-page`: awaiting the operator.\n',
    final_response: '',
  },
  active_subtask: 'implement-page',
  active_role: 'composer',
  events: EVENTS,
  approvals: [
    {
      approval_id: 'gate-1',
      title: 'A subtask is blocked',
      message: 'The composer and evaluator could not reach PASS within the round budget. Add instructions and continue (the subtask is re-opened with fresh rounds), continue without instructions to move on, or stop this run.\n\nSubtask: implement-page — Implement the page',
      options: [
        { value: 'continue', label: 'Continue run', style: 'primary' },
        { value: 'stop', label: 'Stop run', style: 'danger' },
      ],
      answers: [],
      allow_input: true,
      input_label: 'Instructions for re-opening this subtask (leave empty to skip it)',
      allow_extra_rounds: false,
      context: { trigger: 'needs_human', subtask_id: 'implement-page', subtask_title: 'Implement the page' },
      round_index: 1,
      status: 'pending',
      action: '',
      reason: '',
      user_input: '',
      created_at: NOW - 290,
      resolved_at: null,
    },
  ],
  operator_messages: [
    { id: 'msg-1', text: 'Keep the tone neutral — this page must not read as an ad.', created_at: NOW - 1700, status: 'applied' },
  ],
  controls: { can_inject: true, can_abort: true, can_resume: false },
  diagnostics: { last_event_id: 'ev-20', event_count: EVENTS.length, warnings: [], cursor_gap: false, resync_required: false },
};

export const DEMO_RUNS: RunSummary[] = [
  {
    id: 'demo-run',
    task: DEMO_SNAPSHOT.mission.task,
    status: 'waiting_approval',
    updated_at: NOW - 90,
    log_dir: '/runs/demo',
    agent: 'claude_code',
    model: 'claude-opus-5',
    workspace: '/Users/demo/work/site',
    max_rounds: 25,
  },
  {
    id: 'demo-run-old',
    task: 'Migrate the changelog to MDX',
    status: 'completed',
    updated_at: NOW - 90_000,
    log_dir: '/runs/demo-old',
    agent: 'claude_code',
    model: 'claude-opus-5',
  },
];

/** `?demo=1` renders the workbench from the fixture instead of a backend. */
export function isDemoMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}
