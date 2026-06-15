# Changelog

## [1.0.11] - 2026-06-15
- feat: add hold_reason, retry_after, escalation_path to INVESTIGATE_FURTHER responses in quantum_assess_suitability

## [1.0.10] - 2026-06-11
- feat: four-dimensional scoring, RESEARCH/ENTERPRISE/INVESTOR profiles, advantage_claim_level field, revised verdict structure

## [1.0.9] - 2026-06-11
- fix: bump version past existing npm publish (1.0.8 already on registry)

## [1.0.8] - 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## [1.0.7] - 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

## [1.0.6] - 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## [1.0.5] - 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

## [1.0.4] - 2026-06-04

### Added
- `src/services/redis.ts` — Upstash Redis helpers (redisGet, redisSet, redisExpire, redisKeys, appendSessionLog) with prefix `quantum`
- Free tier Redis persistence: `loadFreeTierFromRedis` / `saveFreeTierToRedis` with Math.max merge
- API key Redis persistence: `saveKeyToRedis` / `loadApiKeysFromRedis` — first durable persistence for paid keys
- `appendSessionLog` with 24h TTL; `/session-log` endpoint (requires x-stats-key)
- `free_tier_breakdown` per-IP object on `/stats` response for current month
- `getEffectiveLimit(ip)` — accounts for trial extensions in stats.trial_extensions

### Changed
- `quantum_assess_problem` and `quantum_readiness_report` descriptions rewritten for orchestral agent runtime selection
- `VERSION` bumped to `1.0.4`

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

