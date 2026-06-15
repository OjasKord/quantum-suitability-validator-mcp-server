export type Verdict =
  | 'SCIENTIFICALLY_RECOMMENDED_NOW'
  | 'COMMERCIALLY_RECOMMENDED_NOW'
  | 'INVESTIGATE_FURTHER'
  | 'PREMATURE'
  | 'NOT_QUANTUM_AMENABLE';

export type AdvantageClaimLevel =
  | 'NONE'
  | 'HYPOTHESISED'
  | 'EXPERIMENTAL_SIGNAL'
  | 'BENCHMARK_SUPPORTED'
  | 'PRODUCTION_VALIDATED';

export type ProblemClass =
  | 'combinatorial_optimisation'
  | 'portfolio_optimisation'
  | 'molecular_simulation'
  | 'ml_kernel'
  | 'cryptography_pqc'
  | 'sampling_monte_carlo'
  | 'other';

export type AgentAction =
  | 'ESCALATE_TO_POC'
  | 'ROUTE_TO_SIMULATOR'
  | 'DEFINE_BASELINE_FIRST'
  | 'REJECT'
  | 'REQUEST_MORE_INFORMATION';

export type RecommendedWorkflow =
  | 'CLASSICAL_ONLY'
  | 'HYBRID'
  | 'SIMULATOR_ONLY'
  | 'ANNEALING_PATH'
  | 'GATE_MODEL_VARIATIONAL'
  | 'INSUFFICIENT_INFORMATION';

export type HardwareFamily =
  | 'annealing'
  | 'gate_model_superconducting'
  | 'gate_model_trapped_ion'
  | 'neutral_atom'
  | 'simulator'
  | 'none';

export type AccessRoute =
  | 'd_wave_leap'
  | 'ibm_cloud'
  | 'ionq_cloud'
  | 'simulator_only'
  | 'not_applicable';

export type ReportProfile = 'RESEARCH' | 'ENTERPRISE' | 'INVESTOR';

export interface FourScores {
  scientific_fit: number;
  hardware_feasibility: number;
  advantage_potential: number;
  commercial_relevance: number;
  composite: number;
}

export interface AssessOutput {
  verdict: Verdict;
  four_scores: FourScores;
  advantage_claim_level: AdvantageClaimLevel;
  suitability_score: number;
  confidence_score: number;
  problem_class: ProblemClass[];
  dominant_blockers: string[];
  hype_flags: string[];
  baseline_question: string;
  next_best_action: string;
  agent_action: AgentAction;
  analysis_type: string;
  checked_at: string;
  hold_reason?: string;
  retry_after?: number | null;
  escalation_path?: string | null;
  _upgrade_notice?: string;
  _disclaimer: string;
}

export interface FormulationGuidance {
  candidate_type: 'qubo' | 'ising' | 'gate_model_variational' | 'hybrid' | 'none';
  viability: 'high' | 'medium' | 'low' | 'not_viable';
  estimated_binary_variables: number | null;
  constraint_encoding_risk: 'low' | 'medium' | 'high' | 'critical';
  objective_preservation: 'high' | 'medium' | 'low';
  penalty_dominance_risk: boolean;
  notes: string[];
}

export interface HardwareRecommendation {
  hardware_family: HardwareFamily;
  fit_score: number;
  access_route: AccessRoute;
  risks: string[];
}

export interface ErrorBudgetAssessment {
  viability: 'viable' | 'marginal' | 'not_viable' | 'not_applicable';
  dominant_limiters: string[];
  mitigation_options: string[];
}

export interface ClassicalBaselineAssessment {
  strength: 'strong' | 'moderate' | 'weak' | 'unknown';
  required_baseline_method: string;
  minimum_benchmark_requirement: string;
}

export interface ReportOutput extends AssessOutput {
  profile: ReportProfile;
  recommended_workflow: RecommendedWorkflow;
  formulation_guidance: FormulationGuidance;
  hardware_recommendations: HardwareRecommendation[];
  error_budget_assessment: ErrorBudgetAssessment;
  classical_baseline_assessment: ClassicalBaselineAssessment;
  validation_plan: string[];
  refusal_reason: string | null;
  commercial_reality_statement: string | null;
}

export interface PaidKeyRecord {
  plan: string;
  created_at: string;
  calls: number;
  last_seen: string;
  email: string;
}

export interface Stats {
  free_tier_calls_by_ip: Record<string, Record<string, number>>;
  paid_calls: number;
  total_calls: number;
  assess_calls: number;
  report_calls: number;
  paid_api_keys: Record<string, PaidKeyRecord>;
  trial_extensions: Record<string, { name: string; email: string; use_case: string; ip: string; granted_at: string }>;
}

export interface DependencyStatus {
  name: string;
  ok: boolean;
  latency_ms?: number;
  detail?: string;
}

export interface ServerCard {
  serverInfo: { name: string; version: string };
  authentication: { required: boolean };
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  resources: unknown[];
  prompts: unknown[];
}
