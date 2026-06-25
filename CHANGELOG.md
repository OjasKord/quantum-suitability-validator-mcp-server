# Changelog

## [1.0.19] - 2026-06-25
- Task 1 audit (purpose verb + required fields): already correct on both tools -- ASSESS_DESCRIPTION/REPORT_DESCRIPTION already start with recognized verbs (Analyzes/Generates), and Zod input schemas (problem_description required on both; profile, current_classical_method, constraints_description also required on quantum_readiness_report) already produce a correct `required` array via the SDK's Zod-to-JSON-Schema conversion. No changes needed.
- feat: calls_remaining field added to both tool responses -- "unlimited" for quantum_readiness_report (paid-only) and for paid quantum_assess_problem callers, numeric free-tier headroom otherwise
- feat: verdict_ttl field added (7776000s/90 days on both tools -- hardware landscape moves slowly)
- feat: data_source_status field added (full/degraded/partial). Anthropic is the only external dependency and a failure currently aborts with no verdict (no degraded path exists in this architecture) -- so this server's successful responses always report "full"

## [1.0.18] - 2026-06-24
- feat: unauthenticated /public-stats endpoint -- first_deployed, lifetime tool calls, uptime %, version, for agent orchestrators evaluating server trustworthiness
- feat: /process-trial-followups endpoint + 24h follow-up record on trial-extension grant
- feat: gate responses now self-contained (server + workflow impact + upgrade path in one sentence) and detect cross-server operators via shared fleet Redis, with cross-server trial-extension note
- feat: outputSchema added to both tools via Zod (additive). Added isError:true to the kill-switch and rate-limit paths on both tools so the MCP SDK's output validation doesn't reject them now that outputSchema is enforced
- fix: README documented the pre-rewrite verdict system (RECOMMENDED_NOW/BENCHMARK_ONLY/HYBRID_ONLY/SIMULATOR_ONLY/NOT_RECOMMENDED/INSUFFICIENT_INFORMATION) which doesn't exist anywhere in the code -- the real verdict enum is SCIENTIFICALLY_RECOMMENDED_NOW/COMMERCIALLY_RECOMMENDED_NOW/INVESTIGATE_FURTHER/PREMATURE/NOT_QUANTUM_AMENABLE per the expert-validated four-dimensional scoring architecture shipped 2026-06-11. Rewrote the Tools section to match the actual four_scores/advantage_claim_level/recommended_workflow fields.

## [1.0.17] - 2026-06-23
- fix: gate returns HTTP 402 (x402 standard for non-transient quota)

## [1.0.16] - 2026-06-20
- feat: email notification on free tier gate hit

## [1.0.15] - 2026-06-18
- feat: revoke API key on Stripe refund

## [1.0.14] - 2026-06-17
- feat: add required fields to all tool inputSchemas; add ToolRank CI gate

## [1.0.13] - 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server
- fix: webhook route registered before express.json() — raw body now reaches signature verifier correctly

## [1.0.12] - 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

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

