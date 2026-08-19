# Changelog

## [1.0.30] - 2026-08-19
- fix: v1.0.29's x402 gate/settlement responses carried payment info only in the JSON-RPC body. Confirmed against the installed `@x402/core` client source that the reference `x402HTTPClient` reads `PAYMENT-REQUIRED` (402 discovery) and `PAYMENT-RESPONSE`/`X-PAYMENT-RESPONSE` (settlement confirmation) from HTTP response *headers*, with a body fallback only for x402Version 1 payloads (this server builds v2) -- so a standards-compliant x402 client could not have detected payment-required or confirmed settlement without the headers. Fixed by capturing the Express `res` per-request (`currentRes`, alongside the existing `currentIP`/`currentApiKey` pattern -- MCP SDK tool-handler callbacks don't get raw `res`) and calling `res.setHeader('PAYMENT-REQUIRED', ...)` / `res.setHeader('PAYMENT-RESPONSE', ...)` from inside the gate-error builder and the settle-success path respectively. Empirically verified locally (temporary debug header proved a tool-handler-set header survives onto the real HTTP response through the SDK's StreamableHTTPServerTransport) before implementing the real fix.

## [1.0.29] - 2026-08-19
- added: x402 (mainnet Base) payment rail for `quantum_assess_problem`, ported from tender-mcp's hardened v1.3.4+ integration and adapted for this service's ESM/TS + MCP-SDK architecture (Node 18.20.8 on Railway, confirmed via build logs -- same runtime as Tender). Global `crypto` polyfill for jose@6 WebCrypto; all `@x402/*`/`@coinbase/x402` loading goes through a single `Promise.all([...import(...)])` chain gated on `X402_ENABLED` -- this service has no `require()` at all (`"type":"module"`), so dynamic import() is the only way to load these conditionally rather than unconditionally at every boot. `X402_NETWORK=base` + missing `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` throws synchronously at module load (process exits non-zero before binding a port) -- refuses to ship a dead payment rail. A payment attempt that lands before the async facilitator finishes initializing gets a retryable 402 (`x402_not_ready`), never a silent free-tier grant. Ordering is verify (Express pre-check no longer hard-blocks a request carrying a `payment-signature` header; the tool handler does the real verify) -> execute (`runAssess`) -> settle-or-cancel: a thrown error or a `result.error` cancels the verified-but-unsettled payment via `createPaymentCancellationDispatcher`; only a successful run settles. Bazaar discovery wiring (`declareDiscoveryExtension`) for `quantum_assess_problem`. Distinct `[x402 SETTLEMENT] Quantum` email alert, separate from the routine trial-extension/payment emails. Priced at $0.08/call (see PENDING ACTIONS / rollout notes for the cost-vs-price reasoning). `quantum_readiness_report` (paid-key-only, no free tier) is untouched -- there is no gate on it for x402 to attach to.
- Entire feature gated behind `X402_PAY_TO` -- unset in Railway as of this release, confirmed dormant (byte-identical to pre-x402 behaviour: tools/list, trial-extension, and the free-tier gate all verified unchanged).

## [1.0.28] - 2026-08-19
- security: trial-extension policy changed to one grant per IP, ever. New Redis key `trial_ext_granted:{ipSafe}` (no TTL) is the authoritative dedup — never keyed on name/email, which are attacker-controlled and trivially rotated (this server had 3 grants from a single IP under 3 different emails before this fix). Repeat requests from an already-granted IP get HTTP 200 with `granted:false` and a message pointing to the paid upgrade path, not a re-grant.
- added: Redis-independent in-process circuit breaker (5 new grants/hour/server) as a backstop for the per-IP dedup in case Redis is unreachable.
- ops: revoked 2 of 3 surplus trial-extension grants previously issued to a single probing IP (35.186.14.156); kept the earliest and seeded the new per-IP marker so it counts as that IP's one lifetime extension.

## [1.0.27] - 2026-08-01
- fix: gate hits (free-tier exhausted on quantum_assess_problem) now write a tier:'gated' session-log entry and increment stats.total_calls/assess_calls before the early return, so /daily-report and /stats see gate volume as events instead of being blind to them (new `gate_hits_24h` field). appendSessionLog gained an optional `tier` parameter (defaults to 'success') to carry this.
- removed: notifyGateHit() and the gate-notify.ts shared module — raw free-tier gate hits no longer send an email (still increment counters, still return 402). Email now fires only on a trial-extension request or a Stripe payment event
- added: Redis-independent in-process circuit breaker (20 emails/hour) on the remaining email paths (trial-extension notify/confirm/follow-up, paid API key delivery) so a Redis outage can't fail-open into an email flood (Lesson 209 pattern)

## [1.0.24] - 2026-06-29
- feat: add GET /.well-known/glama.json ownership endpoint for Glama registry verification

## [1.0.23] - 2026-06-28
- fix: gate email dedup — notifyGateHit now async with quantum:gate_email:{ip} Redis key, 1-hour TTL; retries suppressed
- fix: 402 gate response agent_action changed to HALT_WORKFLOW
- fix: trial_extension structured field already present; agent_action now actionable for agents

## [1.0.22] - 2026-06-28
- feat: owner key bypass (OWNER_KEY env var) — fleet owner bypasses free tier and paid-only gates

## [1.0.21] - 2026-06-26
- fix: trial extension requests now written to Redis (quantum:trial:{email}) on grant -- permanent audit trail that survives redeploys; previously in-memory only

## [1.0.20] - 2026-06-25
- fix: .npmignore was missing token.tmp/*.tmp -- a stray token.tmp file shipped in the v1.0.19 npm tarball. Added token.tmp, *.tmp, .claude/, SYSTEM_PROMPT.md, MCP-Build-Playbook* to .npmignore.

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

