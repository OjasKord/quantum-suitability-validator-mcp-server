# Changelog

## [1.0.0] - 2026-05-04

### Added
- Initial release
- `quantum_assess_problem` tool: AI-assisted quantum triage with 7-verdict system (RECOMMENDED_NOW through NOT_QUANTUM_AMENABLE)
- `quantum_readiness_report` tool (Pro): full formulation guidance, hardware family fit, error budget, validation plan
- Free tier: 5 quantum_assess_problem calls/month per IP, no API key required
- Refusal-first assessment engine encoding real expert heuristics: QUBO failure patterns, penalty dominance detection, hype language flags
- Streamable HTTP transport (Railway) + stdio transport (npm/Claude Desktop)
- Stripe webhook integration for Pro key provisioning
- UptimeRobot-compatible /health endpoint (GET + HEAD)
- Anthropic Registry, Smithery, and npm published
