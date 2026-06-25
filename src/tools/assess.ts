import type { AssessInput } from '../schemas/assess.js';
import type { AssessOutput, FourScores, AdvantageClaimLevel } from '../types.js';
import { callClaude, parseClaudeJSON } from '../services/claude-client.js';
import { nowISO, LEGAL_DISCLAIMER, PRO_UPGRADE_URL, VERDICT_TTL } from '../constants.js';

interface ClaudeAssessResponse {
  verdict: string;
  four_scores: {
    scientific_fit: number;
    hardware_feasibility: number;
    advantage_potential: number;
    commercial_relevance: number;
    composite: number;
  };
  advantage_claim_level: string;
  confidence_score: number;
  problem_class: string[];
  dominant_blockers: string[];
  hype_flags: string[];
  baseline_question: string;
  next_best_action: string;
  agent_action: string;
}

function buildAssessPrompt(params: AssessInput): string {
  return [
    'Assess the following quantum computing initiative proposal using the four-dimensional scoring framework.',
    '',
    `PROBLEM DESCRIPTION: ${params.problem_description}`,
    `INDUSTRY: ${params.industry ?? 'not specified'}`,
    `OBJECTIVE TYPE: ${params.objective_type ?? 'not specified'}`,
    `CURRENT CLASSICAL METHOD: ${params.current_classical_method ?? 'not provided'}`,
    `CONSTRAINTS DESCRIPTION: ${params.constraints_description ?? 'not provided'}`,
    `VARIABLE ESTIMATE: ${params.variables_estimate != null ? String(params.variables_estimate) : 'not provided'}`,
    '',
    'Return ONLY a JSON object. No markdown. No explanation. Match this structure exactly:',
    '{',
    '  "verdict": "<SCIENTIFICALLY_RECOMMENDED_NOW|COMMERCIALLY_RECOMMENDED_NOW|INVESTIGATE_FURTHER|PREMATURE|NOT_QUANTUM_AMENABLE>",',
    '  "four_scores": {',
    '    "scientific_fit": <float 0.0-1.0, 40% weight — quantum structural amenability>,',
    '    "hardware_feasibility": <float 0.0-1.0, 25% weight — runnable on current NISQ hardware>,',
    '    "advantage_potential": <float 0.0-1.0, 25% weight — evidence quantum beats best classical>,',
    '    "commercial_relevance": <float 0.0-1.0, 10% weight — business case today>,',
    '    "composite": <0.40*scientific_fit + 0.25*hardware_feasibility + 0.25*advantage_potential + 0.10*commercial_relevance>',
    '  },',
    '  "advantage_claim_level": "<NONE|HYPOTHESISED|EXPERIMENTAL_SIGNAL|BENCHMARK_SUPPORTED|PRODUCTION_VALIDATED>",',
    '  "confidence_score": <float 0.0-1.0>,',
    '  "problem_class": ["<combinatorial_optimisation|portfolio_optimisation|molecular_simulation|ml_kernel|cryptography_pqc|sampling_monte_carlo|other>"],',
    '  "dominant_blockers": ["<string>"],',
    '  "hype_flags": ["<string or empty array>"],',
    '  "baseline_question": "What is your classical baseline today, and what metric must improve for this to matter?",',
    '  "next_best_action": "<specific actionable recommendation>",',
    '  "agent_action": "<ESCALATE_TO_POC|ROUTE_TO_SIMULATOR|DEFINE_BASELINE_FIRST|REJECT|REQUEST_MORE_INFORMATION>"',
    '}'
  ].join('\n');
}

function clamp(v: number): number {
  if (typeof v !== 'number' || isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function clampScores(raw: ClaudeAssessResponse['four_scores'] | undefined): FourScores {
  const s = raw ?? { scientific_fit: 0, hardware_feasibility: 0, advantage_potential: 0, commercial_relevance: 0, composite: 0 };
  const sf = clamp(s.scientific_fit);
  const hf = clamp(s.hardware_feasibility);
  const ap = clamp(s.advantage_potential);
  const cr = clamp(s.commercial_relevance);
  const composite = clamp(0.40 * sf + 0.25 * hf + 0.25 * ap + 0.10 * cr);
  return { scientific_fit: sf, hardware_feasibility: hf, advantage_potential: ap, commercial_relevance: cr, composite };
}

export async function runAssess(
  params: AssessInput
): Promise<{ output?: AssessOutput; error?: Record<string, unknown> }> {
  try {
    const raw = await callClaude(buildAssessPrompt(params), 2000);
    const parsed = parseClaudeJSON<ClaudeAssessResponse>(raw);

    const fourScores = clampScores(parsed.four_scores);

    const output: AssessOutput = {
      verdict: parsed.verdict as AssessOutput['verdict'],
      four_scores: fourScores,
      advantage_claim_level: (parsed.advantage_claim_level ?? 'NONE') as AdvantageClaimLevel,
      suitability_score: fourScores.composite,
      confidence_score: clamp(parsed.confidence_score),
      problem_class: (parsed.problem_class ?? []) as AssessOutput['problem_class'],
      dominant_blockers: parsed.dominant_blockers ?? [],
      hype_flags: parsed.hype_flags ?? [],
      baseline_question:
        parsed.baseline_question ??
        'What is your classical baseline today, and what metric must improve for this to matter?',
      next_best_action: parsed.next_best_action ?? '',
      agent_action: parsed.agent_action as AssessOutput['agent_action'],
      analysis_type: 'AI-assisted quantum triage — NOT a substitute for experimental physicist review',
      checked_at: nowISO(),
      _disclaimer: LEGAL_DISCLAIMER,
      calls_remaining: 0, // overwritten by index.ts once free/paid status is known
      verdict_ttl: VERDICT_TTL.quantum_assess_problem,
      data_source_status: 'full'
    };

    if (parsed.verdict === 'INVESTIGATE_FURTHER') {
      output.hold_reason = parsed.dominant_blockers?.[0] || 'Quantum advantage for this problem requires further experimental validation before committing resources';
      output.retry_after = null;
      output.escalation_path = 'Define classical baseline performance metrics first, then consult a quantum computing specialist to evaluate feasibility before committing to implementation';
    }

    const isNotAmenable = parsed.verdict === 'NOT_QUANTUM_AMENABLE' || parsed.verdict === 'PREMATURE';
    if (!isNotAmenable) {
      output._upgrade_notice =
        'Verdict delivered. The full Quantum Readiness Report — formulation path, hardware family fit, ' +
        'error budget viability, and validation plan — is Pro only. ' +
        `Upgrade at kordagencies.com.`;
    }

    return { output };
  } catch (err) {
    return {
      error: {
        error: 'Assessment failed',
        likely_cause:
          err instanceof Error ? err.message : 'Unexpected error during AI analysis',
        agent_action:
          'Retry once with a more specific problem description. ' +
          'If error persists, contact support at ojas@kordagencies.com.',
        upgrade_url: PRO_UPGRADE_URL
      }
    };
  }
}

export function formatAssessMarkdown(output: AssessOutput): string {
  const fs = output.four_scores;
  const lines = [
    '## Quantum Suitability Assessment',
    `**Verdict:** ${output.verdict}`,
    `**Advantage Claim Level:** ${output.advantage_claim_level}`,
    '',
    '### Four-Dimensional Scores',
    `| Dimension | Score | Weight |`,
    `|---|---|---|`,
    `| Scientific Fit | ${fs.scientific_fit.toFixed(2)} | 40% |`,
    `| Hardware Feasibility | ${fs.hardware_feasibility.toFixed(2)} | 25% |`,
    `| Advantage Potential | ${fs.advantage_potential.toFixed(2)} | 25% |`,
    `| Commercial Relevance | ${fs.commercial_relevance.toFixed(2)} | 10% |`,
    `| **Composite** | **${fs.composite.toFixed(2)}** | |`,
    '',
    `**Confidence Score:** ${output.confidence_score.toFixed(2)}`,
    `**Agent Action:** ${output.agent_action}`,
    '',
    `**Problem Class:** ${output.problem_class.join(', ')}`,
    '',
    '**Dominant Blockers:**',
    ...(output.dominant_blockers.length
      ? output.dominant_blockers.map(b => `- ${b}`)
      : ['- None identified']),
    '',
    '**Hype Flags:**',
    ...(output.hype_flags.length
      ? output.hype_flags.map(f => `- ${f}`)
      : ['- None detected']),
    '',
    `**Baseline Question:** ${output.baseline_question}`,
    '',
    `**Next Best Action:** ${output.next_best_action}`,
    '',
    `*${output.analysis_type}*`,
    `*Checked at: ${output.checked_at}*`
  ];

  if (output._upgrade_notice) {
    lines.push('', `**Upgrade Notice:** ${output._upgrade_notice}`);
  }
  lines.push('', `*${output._disclaimer}*`);
  return lines.join('\n');
}
