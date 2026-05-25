import type { AssessInput } from '../schemas/assess.js';
import type { AssessOutput } from '../types.js';
import { callClaude, parseClaudeJSON } from '../services/claude-client.js';
import { nowISO, LEGAL_DISCLAIMER, PRO_UPGRADE_URL } from '../constants.js';

interface ClaudeAssessResponse {
  verdict: string;
  suitability_score: number;
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
    'Assess the following quantum computing initiative proposal.',
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
    '  "verdict": "<RECOMMENDED_NOW|BENCHMARK_ONLY|HYBRID_ONLY|SIMULATOR_ONLY|NOT_RECOMMENDED|NOT_QUANTUM_AMENABLE|INSUFFICIENT_INFORMATION>",',
    '  "suitability_score": <float 0.0-1.0>,',
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

export async function runAssess(
  params: AssessInput
): Promise<{ output?: AssessOutput; error?: Record<string, unknown> }> {
  try {
    const raw = await callClaude(buildAssessPrompt(params), 2000);
    const parsed = parseClaudeJSON<ClaudeAssessResponse>(raw);

    const isInsufficient = parsed.verdict === 'INSUFFICIENT_INFORMATION';

    const output: AssessOutput = {
      verdict: parsed.verdict as AssessOutput['verdict'],
      suitability_score: clamp(parsed.suitability_score),
      confidence_score: clamp(parsed.confidence_score),
      problem_class: (parsed.problem_class ?? []) as AssessOutput['problem_class'],
      dominant_blockers: parsed.dominant_blockers ?? [],
      hype_flags: parsed.hype_flags ?? [],
      baseline_question:
        parsed.baseline_question ??
        'What is your classical baseline today, and what metric must improve for this to matter?',
      next_best_action: parsed.next_best_action ?? '',
      agent_action: parsed.agent_action as AssessOutput['agent_action'],
      analysis_type: 'AI-assisted quantum triage -- NOT a substitute for experimental physicist review',
      checked_at: nowISO(),
      _disclaimer: LEGAL_DISCLAIMER
    };

    if (!isInsufficient) {
      output._upgrade_notice =
        'Verdict delivered. The full Quantum Readiness Report -- formulation path, hardware family fit, ' +
        'error budget viability, and validation plan -- is Pro only. ' +
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
  const lines = [
    '## Quantum Suitability Assessment',
    `**Verdict:** ${output.verdict}`,
    `**Suitability Score:** ${output.suitability_score.toFixed(2)}`,
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
