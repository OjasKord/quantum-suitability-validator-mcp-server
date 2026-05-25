import type { ReportInput } from '../schemas/report.js';
import type { ReportOutput, AssessOutput } from '../types.js';
import { callClaude, parseClaudeJSON } from '../services/claude-client.js';
import { nowISO, LEGAL_DISCLAIMER } from '../constants.js';

interface ClaudeReportResponse {
  verdict: string;
  suitability_score: number;
  confidence_score: number;
  problem_class: string[];
  dominant_blockers: string[];
  hype_flags: string[];
  baseline_question: string;
  next_best_action: string;
  agent_action: string;
  recommended_workflow: string;
  formulation_guidance: {
    candidate_type: string;
    viability: string;
    estimated_binary_variables: number | null;
    constraint_encoding_risk: string;
    objective_preservation: string;
    penalty_dominance_risk: boolean;
    notes: string[];
  };
  hardware_recommendations: Array<{
    hardware_family: string;
    fit_score: number;
    access_route: string;
    risks: string[];
  }>;
  error_budget_assessment: {
    viability: string;
    dominant_limiters: string[];
    mitigation_options: string[];
  };
  classical_baseline_assessment: {
    strength: string;
    required_baseline_method: string;
    minimum_benchmark_requirement: string;
  };
  validation_plan: string[];
  refusal_reason: string | null;
}

function buildReportPrompt(params: ReportInput): string {
  return [
    'Generate a full Quantum Readiness Report for the following initiative.',
    '',
    `PROBLEM DESCRIPTION: ${params.problem_description}`,
    `INDUSTRY: ${params.industry ?? 'not specified'}`,
    `OBJECTIVE TYPE: ${params.objective_type ?? 'not specified'}`,
    `CURRENT CLASSICAL METHOD: ${params.current_classical_method}`,
    `CONSTRAINTS DESCRIPTION: ${params.constraints_description}`,
    `VARIABLE ESTIMATE: ${params.variables_estimate != null ? String(params.variables_estimate) : 'not provided'}`,
    `SUCCESS METRIC: ${params.success_metric ?? 'not provided'}`,
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
    '  "agent_action": "<ESCALATE_TO_POC|ROUTE_TO_SIMULATOR|DEFINE_BASELINE_FIRST|REJECT|REQUEST_MORE_INFORMATION>",',
    '  "recommended_workflow": "<CLASSICAL_ONLY|HYBRID|SIMULATOR_ONLY|ANNEALING_PATH|GATE_MODEL_VARIATIONAL|INSUFFICIENT_INFORMATION>",',
    '  "formulation_guidance": {',
    '    "candidate_type": "<qubo|ising|gate_model_variational|hybrid|none>",',
    '    "viability": "<high|medium|low|not_viable>",',
    '    "estimated_binary_variables": <integer or null>,',
    '    "constraint_encoding_risk": "<low|medium|high|critical>",',
    '    "objective_preservation": "<high|medium|low>",',
    '    "penalty_dominance_risk": <boolean>,',
    '    "notes": ["<string>"]',
    '  },',
    '  "hardware_recommendations": [',
    '    {',
    '      "hardware_family": "<annealing|gate_model_superconducting|gate_model_trapped_ion|neutral_atom|simulator|none>",',
    '      "fit_score": <float 0.0-1.0>,',
    '      "access_route": "<d_wave_leap|ibm_cloud|ionq_cloud|simulator_only|not_applicable>",',
    '      "risks": ["<string>"]',
    '    }',
    '  ],',
    '  "error_budget_assessment": {',
    '    "viability": "<viable|marginal|not_viable|not_applicable>",',
    '    "dominant_limiters": ["<string>"],',
    '    "mitigation_options": ["<string>"]',
    '  },',
    '  "classical_baseline_assessment": {',
    '    "strength": "<strong|moderate|weak|unknown>",',
    '    "required_baseline_method": "<string>",',
    '    "minimum_benchmark_requirement": "<string>"',
    '  },',
    '  "validation_plan": ["<ordered step string>"],',
    '  "refusal_reason": "<string or null>"',
    '}'
  ].join('\n');
}

function clamp(v: number): number {
  if (typeof v !== 'number' || isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export async function runReport(
  params: ReportInput
): Promise<{ output?: ReportOutput; error?: Record<string, unknown> }> {
  try {
    const raw = await callClaude(buildReportPrompt(params), 3000);
    const parsed = parseClaudeJSON<ClaudeReportResponse>(raw);
    const fg = parsed.formulation_guidance ?? {};

    const output: ReportOutput = {
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
      recommended_workflow: parsed.recommended_workflow as ReportOutput['recommended_workflow'],
      formulation_guidance: {
        candidate_type: (fg.candidate_type ?? 'none') as ReportOutput['formulation_guidance']['candidate_type'],
        viability: (fg.viability ?? 'not_viable') as ReportOutput['formulation_guidance']['viability'],
        estimated_binary_variables: fg.estimated_binary_variables ?? null,
        constraint_encoding_risk: (fg.constraint_encoding_risk ?? 'critical') as ReportOutput['formulation_guidance']['constraint_encoding_risk'],
        objective_preservation: (fg.objective_preservation ?? 'low') as ReportOutput['formulation_guidance']['objective_preservation'],
        penalty_dominance_risk: fg.penalty_dominance_risk ?? false,
        notes: fg.notes ?? []
      },
      hardware_recommendations: (parsed.hardware_recommendations ?? []).map(r => ({
        hardware_family: r.hardware_family as ReportOutput['hardware_recommendations'][0]['hardware_family'],
        fit_score: clamp(r.fit_score),
        access_route: r.access_route as ReportOutput['hardware_recommendations'][0]['access_route'],
        risks: r.risks ?? []
      })),
      error_budget_assessment: {
        viability: (parsed.error_budget_assessment?.viability ?? 'not_applicable') as ReportOutput['error_budget_assessment']['viability'],
        dominant_limiters: parsed.error_budget_assessment?.dominant_limiters ?? [],
        mitigation_options: parsed.error_budget_assessment?.mitigation_options ?? []
      },
      classical_baseline_assessment: {
        strength: (parsed.classical_baseline_assessment?.strength ?? 'unknown') as ReportOutput['classical_baseline_assessment']['strength'],
        required_baseline_method: parsed.classical_baseline_assessment?.required_baseline_method ?? '',
        minimum_benchmark_requirement: parsed.classical_baseline_assessment?.minimum_benchmark_requirement ?? ''
      },
      validation_plan: parsed.validation_plan ?? [],
      refusal_reason: parsed.refusal_reason ?? null,
      _disclaimer: LEGAL_DISCLAIMER
    };

    return { output };
  } catch (err) {
    return {
      error: {
        error: 'Report generation failed',
        likely_cause:
          err instanceof Error ? err.message : 'Unexpected error during AI analysis',
        agent_action:
          'Retry once with more specific problem description, classical method, and constraints. ' +
          'If error persists, contact support at ojas@kordagencies.com.'
      }
    };
  }
}

export function formatReportMarkdown(output: ReportOutput): string {
  const fg = output.formulation_guidance;
  const lines = [
    '## Quantum Readiness Report',
    `**Verdict:** ${output.verdict}`,
    `**Suitability Score:** ${output.suitability_score.toFixed(2)}`,
    `**Confidence Score:** ${output.confidence_score.toFixed(2)}`,
    `**Recommended Workflow:** ${output.recommended_workflow}`,
    `**Agent Action:** ${output.agent_action}`,
    '',
    `**Problem Class:** ${output.problem_class.join(', ')}`,
    '',
    '### Formulation Guidance',
    `- Candidate Type: ${fg.candidate_type}`,
    `- Viability: ${fg.viability}`,
    `- Estimated Binary Variables: ${fg.estimated_binary_variables ?? 'N/A'}`,
    `- Constraint Encoding Risk: ${fg.constraint_encoding_risk}`,
    `- Objective Preservation: ${fg.objective_preservation}`,
    `- Penalty Dominance Risk: ${fg.penalty_dominance_risk}`,
    ...fg.notes.map(n => `- ${n}`),
    '',
    '### Hardware Recommendations',
    ...output.hardware_recommendations.map(
      r => `- **${r.hardware_family}** (fit: ${r.fit_score.toFixed(2)}, via ${r.access_route}): ${r.risks.join('; ')}`
    ),
    '',
    '### Error Budget',
    `Viability: ${output.error_budget_assessment.viability}`,
    ...output.error_budget_assessment.dominant_limiters.map(l => `- ${l}`),
    '',
    '### Classical Baseline',
    `Strength: ${output.classical_baseline_assessment.strength}`,
    `Required Method: ${output.classical_baseline_assessment.required_baseline_method}`,
    `Minimum Benchmark: ${output.classical_baseline_assessment.minimum_benchmark_requirement}`,
    '',
    '### Validation Plan',
    ...output.validation_plan.map((step, i) => `${i + 1}. ${step}`),
    '',
    '**Dominant Blockers:**',
    ...(output.dominant_blockers.length
      ? output.dominant_blockers.map(b => `- ${b}`)
      : ['- None identified']),
    '',
    `**Next Best Action:** ${output.next_best_action}`,
    '',
    `*${output.analysis_type}*`,
    `*Checked at: ${output.checked_at}*`,
    '',
    `*${output._disclaimer}*`
  ];
  return lines.join('\n');
}
