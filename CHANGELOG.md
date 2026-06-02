# Changelog

## [1.0.3] - 2026-06-02

### Fixed
- fix: IP extraction fixed for Cloudflare proxy headers — free tier gate now enforces correctly

## [1.0.2] - 2026-05-25

### Fixed
- Claude API timeout wrapper added (25s `Promise.race`) to prevent Railway 502 on complex calls
- Graceful structured error response returned on timeout instead of crashing the handler
- `max_tokens` tuned: 2000 for `quantum_assess_problem`, 3000 for `quantum_readiness_report`

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
