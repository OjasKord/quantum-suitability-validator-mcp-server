import { z } from 'zod';
import { AssessOutputSchema } from './assess.js';

export const ReportInputSchema = z.object({
  problem_description: z.string()
    .min(20, 'Problem description must be at least 20 characters')
    .max(5000, 'Problem description must not exceed 5000 characters')
    .describe(
      'Description of the problem proposed for quantum computing. ' +
      'Minimum 20 characters. Include what it computes and what a win looks like.'
    ),
  profile: z.enum(['RESEARCH', 'ENTERPRISE', 'INVESTOR'])
    .describe(
      'Audience profile that determines scoring weights. ' +
      'RESEARCH: scientific fit 45%, hardware feasibility 35%, advantage evidence 15%, commercial 5%. ' +
      'ENTERPRISE: commercial 35%, advantage evidence 35%, hardware feasibility 20%, scientific fit 10%. ' +
      'INVESTOR: advantage evidence 40%, commercial 30%, hardware feasibility 20%, scientific fit 10%.'
    ),
  industry: z.string()
    .max(100, 'Industry must not exceed 100 characters')
    .optional()
    .describe('Industry or sector context (e.g. finance, logistics, pharma, energy, manufacturing)'),
  objective_type: z.enum(['optimisation', 'simulation', 'sampling', 'ml', 'cryptography', 'other'])
    .optional()
    .describe('Primary objective type: optimisation, simulation, sampling, ml, cryptography, or other'),
  current_classical_method: z.string()
    .min(5, 'Classical method must be at least 5 characters')
    .max(500, 'Classical method description must not exceed 500 characters')
    .describe(
      'REQUIRED. Current classical algorithm or solver being used ' +
      '(e.g. OR-Tools, CPLEX, MIP, heuristics, Monte Carlo). ' +
      'Used for baseline strength assessment and hardware fit scoring.'
    ),
  constraints_description: z.string()
    .min(5, 'Constraints description must be at least 5 characters')
    .max(1000, 'Constraints description must not exceed 1000 characters')
    .describe(
      'REQUIRED. Description of problem constraints — equality constraints, ' +
      'cardinality limits, if/then rules, etc. Used for QUBO formulation risk analysis.'
    ),
  variables_estimate: z.number()
    .int('Variables estimate must be an integer')
    .min(1, 'Variables estimate must be at least 1')
    .max(10000000, 'Variables estimate must not exceed 10,000,000')
    .optional()
    .describe('Estimated number of decision variables in the problem'),
  success_metric: z.string()
    .max(500, 'Success metric must not exceed 500 characters')
    .optional()
    .describe(
      'Measurable success criterion — what improvement vs baseline makes this worth a pilot ' +
      '(e.g. "10% cost reduction vs OR-Tools baseline on 200-node benchmark")'
    ),
  response_format: z.enum(['markdown', 'json'])
    .default('json')
    .describe("Output format: 'json' for machine-readable agent use (default), 'markdown' for human-readable display")
}).strict();

export type ReportInput = z.infer<typeof ReportInputSchema>;

export const ReportOutputSchema = AssessOutputSchema.extend({
  profile: z.enum(['RESEARCH', 'ENTERPRISE', 'INVESTOR']),
  recommended_workflow: z.enum(['CLASSICAL_ONLY', 'HYBRID', 'SIMULATOR_ONLY', 'ANNEALING_PATH', 'GATE_MODEL_VARIATIONAL', 'INSUFFICIENT_INFORMATION']),
  formulation_guidance: z.object({
    candidate_type: z.enum(['qubo', 'ising', 'gate_model_variational', 'hybrid', 'none']),
    viability: z.enum(['high', 'medium', 'low', 'not_viable']),
    estimated_binary_variables: z.number().nullable(),
    constraint_encoding_risk: z.enum(['low', 'medium', 'high', 'critical']),
    objective_preservation: z.enum(['high', 'medium', 'low']),
    penalty_dominance_risk: z.boolean(),
    notes: z.array(z.string())
  }),
  hardware_recommendations: z.array(z.object({
    hardware_family: z.enum(['annealing', 'gate_model_superconducting', 'gate_model_trapped_ion', 'neutral_atom', 'simulator', 'none']),
    fit_score: z.number().min(0).max(1),
    access_route: z.enum(['d_wave_leap', 'ibm_cloud', 'ionq_cloud', 'simulator_only', 'not_applicable']),
    risks: z.array(z.string())
  })),
  error_budget_assessment: z.object({
    viability: z.enum(['viable', 'marginal', 'not_viable', 'not_applicable']),
    dominant_limiters: z.array(z.string()),
    mitigation_options: z.array(z.string())
  }),
  classical_baseline_assessment: z.object({
    strength: z.enum(['strong', 'moderate', 'weak', 'unknown']),
    required_baseline_method: z.string(),
    minimum_benchmark_requirement: z.string()
  }),
  validation_plan: z.array(z.string()),
  refusal_reason: z.string().nullable(),
  commercial_reality_statement: z.string().nullable()
});
