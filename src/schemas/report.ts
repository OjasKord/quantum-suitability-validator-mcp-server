import { z } from 'zod';

export const ReportInputSchema = z.object({
  problem_description: z.string()
    .min(20, 'Problem description must be at least 20 characters')
    .max(5000, 'Problem description must not exceed 5000 characters')
    .describe(
      'Description of the problem proposed for quantum computing. ' +
      'Minimum 20 characters. Include what it computes and what a win looks like.'
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
      'REQUIRED. Description of problem constraints -- equality constraints, ' +
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
      'Measurable success criterion -- what improvement vs baseline makes this worth a pilot ' +
      '(e.g. "10% cost reduction vs OR-Tools baseline on 200-node benchmark")'
    ),
  response_format: z.enum(['markdown', 'json'])
    .default('json')
    .describe("Output format: 'json' for machine-readable agent use (default), 'markdown' for human-readable display")
}).strict();

export type ReportInput = z.infer<typeof ReportInputSchema>;
