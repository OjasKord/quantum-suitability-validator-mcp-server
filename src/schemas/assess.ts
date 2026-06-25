import { z } from 'zod';

export const AssessInputSchema = z.object({
  problem_description: z.string()
    .min(20, 'Problem description must be at least 20 characters')
    .max(5000, 'Problem description must not exceed 5000 characters')
    .describe(
      'Description of the problem proposed for quantum computing. ' +
      'Minimum 20 characters. Include what it computes, why classical is insufficient, ' +
      'and what a win looks like.'
    ),
  industry: z.string()
    .max(100, 'Industry must not exceed 100 characters')
    .optional()
    .describe('Industry or sector context (e.g. finance, logistics, pharma, energy, manufacturing)'),
  objective_type: z.enum(['optimisation', 'simulation', 'sampling', 'ml', 'cryptography', 'other'])
    .optional()
    .describe('Primary objective type: optimisation, simulation, sampling, ml, cryptography, or other'),
  current_classical_method: z.string()
    .max(500, 'Classical method description must not exceed 500 characters')
    .optional()
    .describe(
      'Current classical algorithm or solver being used ' +
      '(e.g. OR-Tools, CPLEX, MIP, heuristics, Monte Carlo). ' +
      'Providing this reduces NOT_QUANTUM_AMENABLE false positives.'
    ),
  constraints_description: z.string()
    .max(1000, 'Constraints description must not exceed 1000 characters')
    .optional()
    .describe(
      'Description of problem constraints -- equality constraints, cardinality limits, ' +
      'if/then rules, etc. Absence of this is the leading cause of QUBO failure.'
    ),
  variables_estimate: z.number()
    .int('Variables estimate must be an integer')
    .min(1, 'Variables estimate must be at least 1')
    .max(10000000, 'Variables estimate must not exceed 10,000,000')
    .optional()
    .describe('Estimated number of decision variables in the problem'),
  response_format: z.enum(['markdown', 'json'])
    .default('json')
    .describe("Output format: 'json' for machine-readable agent use (default), 'markdown' for human-readable display")
}).strict();

export type AssessInput = z.infer<typeof AssessInputSchema>;

export const AssessOutputSchema = z.object({
  verdict: z.enum(['SCIENTIFICALLY_RECOMMENDED_NOW', 'COMMERCIALLY_RECOMMENDED_NOW', 'INVESTIGATE_FURTHER', 'PREMATURE', 'NOT_QUANTUM_AMENABLE']),
  four_scores: z.object({
    scientific_fit: z.number().min(0).max(1),
    hardware_feasibility: z.number().min(0).max(1),
    advantage_potential: z.number().min(0).max(1),
    commercial_relevance: z.number().min(0).max(1),
    composite: z.number().min(0).max(1)
  }),
  advantage_claim_level: z.enum(['NONE', 'HYPOTHESISED', 'EXPERIMENTAL_SIGNAL', 'BENCHMARK_SUPPORTED', 'PRODUCTION_VALIDATED']),
  suitability_score: z.number().min(0).max(1),
  confidence_score: z.number().min(0).max(1),
  problem_class: z.array(z.string()),
  dominant_blockers: z.array(z.string()),
  hype_flags: z.array(z.string()),
  baseline_question: z.string(),
  next_best_action: z.string(),
  agent_action: z.enum(['ESCALATE_TO_POC', 'ROUTE_TO_SIMULATOR', 'DEFINE_BASELINE_FIRST', 'REJECT', 'REQUEST_MORE_INFORMATION']),
  analysis_type: z.string(),
  checked_at: z.string(),
  hold_reason: z.string().optional(),
  retry_after: z.number().nullable().optional(),
  escalation_path: z.string().nullable().optional(),
  _upgrade_notice: z.string().optional(),
  _disclaimer: z.string(),
  calls_remaining: z.union([z.number(), z.literal('unlimited')]),
  verdict_ttl: z.number(),
  data_source_status: z.enum(['full', 'degraded', 'partial'])
});
