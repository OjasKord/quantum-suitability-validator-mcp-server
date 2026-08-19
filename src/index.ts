import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import axios from 'axios';

import {
  VERSION,
  PERSIST_FILE,
  FREE_TIER_LIMIT,
  TRIAL_EXTENSION_CALLS,
  LEGAL_DISCLAIMER,
  PRO_UPGRADE_URL,
  ENTERPRISE_UPGRADE_URL,
  FREE_TIER_REDIS_KEY,
  ALLOWED_PAYMENT_LINK_IDS,
  FIRST_DEPLOYED,
  LIFETIME_CALLS_REDIS_KEY,
  UPTIME_HEARTBEAT_KEY,
  UPTIME_MONITORING_START_KEY,
  UPTIME_HEARTBEAT_INTERVAL_MS,
  nowISO
} from './constants.js';
import type { Stats, DependencyStatus, ServerCard, PaidKeyRecord } from './types.js';
import { REDIS_PREFIX, redisGet, redisSet, redisKeys, redisDelete, appendSessionLog, redisIncr, initUptimeTracking, recordFleetGateHit, buildCrossServerNote } from './services/redis.js';
import { AssessInputSchema, AssessOutputSchema } from './schemas/assess.js';
import { ReportInputSchema, ReportOutputSchema } from './schemas/report.js';
import { runAssess, formatAssessMarkdown } from './tools/assess.js';
import { runReport, formatReportMarkdown } from './tools/report.js';

// jose@6 (pulled in transitively by @coinbase/x402 for mainnet CDP auth) is a WebCrypto-only
// build that references a bare global `crypto`. Node 20+ exposes that global by default; Node
// 18 (Railway's runtime for this service, confirmed via build logs -- mise node@18.20.8) does
// not unless run with --experimental-global-webcrypto. Polyfilling here is a no-op wherever the
// global already exists. Ported verbatim from tender-mcp's hardened v1.3.4+ mainnet arm.
if (!(globalThis as unknown as { crypto?: unknown }).crypto) {
  (globalThis as unknown as { crypto: unknown }).crypto = crypto.webcrypto;
}

// ---------------------------------------------------------------------------
// Request context -- set per HTTP request; stdio uses defaults
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';
let currentOwnerKey = '';
let currentPaymentSignature = '';

const OWNER_KEY = process.env.OWNER_KEY ?? '';
const isOwner = (): boolean => OWNER_KEY !== '' && currentOwnerKey === OWNER_KEY;

// ---------------------------------------------------------------------------
// X402 (mainnet Base) -- port of tender-mcp's hardened v1.3.4+ x402 integration.
// Zero-regression contract: every x402 code path below is gated behind X402_ENABLED,
// which is false unless X402_PAY_TO is set. With it unset, none of this runs -- byte-
// identical to pre-x402 behaviour.
// ---------------------------------------------------------------------------
const X402_PAY_TO = process.env.X402_PAY_TO ?? '';
const X402_NETWORK_ENV = process.env.X402_NETWORK ?? 'base-sepolia';
const X402_CAIP_NETWORK: string | null =
  ({ 'base-sepolia': 'eip155:84532', base: 'eip155:8453' } as Record<string, string>)[X402_NETWORK_ENV] ?? null;
const X402_FACILITATOR_URL: string | null =
  ({ 'base-sepolia': 'https://x402.org/facilitator', base: 'https://api.cdp.coinbase.com/platform/v2/x402' } as Record<string, string>)[X402_NETWORK_ENV] ?? null;
const X402_ENABLED = !!(X402_PAY_TO && X402_CAIP_NETWORK && X402_FACILITATOR_URL);
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID ?? '';
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET ?? '';
// quantum_assess_problem only -- quantum_readiness_report is paid-key-only, never free-tier
// gated, so there is no gate for x402 to attach to on that tool.
const TOOL_PRICES: Record<string, string> = { quantum_assess_problem: '$0.08' };

let x402Server: any = null;
// True only once initialize() has genuinely resolved. Dynamic import() is async, so there is a
// real window after the process starts accepting connections where x402Server exists but isn't
// ready yet -- the assess handler uses this flag to fail closed on a payment attempt during that
// window instead of silently treating it as a free-tier call.
let x402Ready = false;
let decodePaymentSignatureHeader: ((header: string) => any) | null = null;
let declareDiscoveryExtension: ((opts: any) => any) | null = null;
let X402_DISCOVERY_EXTENSIONS: Record<string, any> = {};

if (X402_ENABLED) {
  // base (mainnet): CDP's hosted facilitator REQUIRES authenticated verify/settle calls. An
  // unauthenticated client is silently rejected by CDP, which would look armed but never
  // actually settle -- fail loudly at startup instead of shipping a dead payment rail. This
  // throw is synchronous at module load, so a misconfigured mainnet arm crashes the process
  // (exit code 1) before it ever binds a port -- Railway's healthcheck fails immediately
  // instead of silently serving a broken payment rail.
  if (X402_NETWORK_ENV === 'base' && (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET)) {
    throw new Error('[x402] X402_NETWORK=base requires CDP_API_KEY_ID and CDP_API_KEY_SECRET -- the CDP mainnet facilitator rejects unauthenticated verify/settle calls. Refusing to start with a dead payment rail.');
  }

  // This service is pure ESM ("type":"module") -- there is no require() available at all, so
  // dynamic import() is not just a workaround for the jose@6/Node-18 ERR_REQUIRE_ESM issue
  // (which is a require()-only problem tender-mcp's CJS build hits and this file structurally
  // cannot), it is the ONLY mechanism available to load these packages conditionally on
  // X402_ENABLED rather than unconditionally at every boot, dormant or not.
  Promise.all([
    import('@x402/core/server'),
    import('@x402/core/http'),
    import('@x402/evm/exact/server'),
    import('@x402/extensions/bazaar'),
    X402_NETWORK_ENV === 'base' ? import('@coinbase/x402') : Promise.resolve(null)
  ]).then(([core, http, evm, bazaarExt, coinbase]) => {
    decodePaymentSignatureHeader = http.decodePaymentSignatureHeader;
    declareDiscoveryExtension = bazaarExt.declareDiscoveryExtension;

    const facilitatorConfig =
      X402_NETWORK_ENV === 'base' && coinbase
        ? coinbase.createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
        : { url: X402_FACILITATOR_URL };

    x402Server = new core.x402ResourceServer(new core.HTTPFacilitatorClient(facilitatorConfig));
    evm.registerExactEvmScheme(x402Server, {});
    x402Server.registerExtension(bazaarExt.bazaarResourceServerExtension);

    X402_DISCOVERY_EXTENSIONS.quantum_assess_problem = declareDiscoveryExtension!({
      toolName: 'quantum_assess_problem',
      description: ASSESS_DESCRIPTION.slice(0, 500),
      inputSchema: { type: 'object', properties: { problem_description: { type: 'string' } }, required: ['problem_description'] },
      example: { problem_description: 'Simulate a 12-electron hydrogen chain ground-state energy for a materials-discovery pipeline; classical DFT solvers plateau in accuracy above this size.' },
      output: { example: { verdict: 'SCIENTIFICALLY_RECOMMENDED_NOW', scientific_fit: 78, hardware_feasibility: 61, advantage_potential: 55, commercial_relevance: 40 } }
    });

    return x402Server.initialize();
  }).then(() => {
    x402Ready = true;
    console.log('[x402] resource server initialized — network=' + X402_CAIP_NETWORK + ' facilitator=' + X402_FACILITATOR_URL);
  }).catch((e: Error) => {
    console.error('[x402] facilitator setup failed:', e.message);
    if (X402_NETWORK_ENV === 'base') {
      // A mainnet rail that looks armed (X402_PAY_TO set) but can never verify/settle is worse
      // than not starting at all -- crash loudly instead of serving silently-dead payments.
      process.exit(1);
    }
  });
}

async function logX402SettleFailure(details: Record<string, unknown>): Promise<void> {
  const monthKey = REDIS_PREFIX + ':x402_settle_failures:' + new Date().toISOString().slice(0, 7);
  redisIncr(monthKey).catch(() => {});
  redisSet(REDIS_PREFIX + ':x402_settle_failure:last', Object.assign({ at: nowISO() }, details)).catch(() => {});
  console.error('[x402] SETTLE FAILED — not charging, not delivering paid result:', JSON.stringify(details));
}

// Verifies a payment attached via the PAYMENT-SIGNATURE header (captured into
// currentPaymentSignature by the /mcp handler before transport handoff, since MCP SDK tool
// handlers don't receive the raw Express req). Returns null (not an error) if x402 isn't
// enabled, the tool isn't priced, no payment header is present, or the payment doesn't verify --
// all of these mean "fall through to normal free-tier/gate behaviour", not "reject".
async function checkX402Payment(paymentSignature: string, toolName: string): Promise<{ payload: any; requirements: any } | null> {
  if (!X402_ENABLED || !x402Server || !decodePaymentSignatureHeader) return null;
  const price = TOOL_PRICES[toolName];
  if (!price || !paymentSignature) return null;
  let payload;
  try { payload = decodePaymentSignatureHeader(paymentSignature); }
  catch { return null; }
  let requirements;
  try {
    const built = await x402Server.buildPaymentRequirements({ scheme: 'exact', payTo: X402_PAY_TO, price, network: X402_CAIP_NETWORK, maxTimeoutSeconds: 60 });
    requirements = built[0];
  } catch (e) { console.error('[x402] buildPaymentRequirements failed:', (e as Error).message); return null; }
  let verifyResult;
  try { verifyResult = await x402Server.verifyPayment(payload, requirements); }
  catch (e) { console.error('[x402] verifyPayment failed:', (e as Error).message); return null; }
  if (!verifyResult || !verifyResult.isValid) return null;
  return { payload, requirements };
}

const perMinuteUsage = new Map<string, number>();

function checkPerMinuteLimit(ip: string, toolName: string, limit: number): boolean {
  const minuteKey = ip + ':' + toolName + ':' + new Date().toISOString().slice(0, 16);
  const count = perMinuteUsage.get(minuteKey) ?? 0;
  if (count >= limit) return false;
  perMinuteUsage.set(minuteKey, count + 1);
  if (perMinuteUsage.size > 10000) {
    const currentMinute = new Date().toISOString().slice(0, 16);
    for (const [key] of perMinuteUsage) {
      if (!key.includes(currentMinute)) perMinuteUsage.delete(key);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stats persistence
// ---------------------------------------------------------------------------
function loadStats(): Stats {
  try {
    const parsed = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')) as Stats;
    if (!parsed.trial_extensions) parsed.trial_extensions = {};
    return parsed;
  } catch {
    return {
      free_tier_calls_by_ip: {},
      paid_calls: 0,
      total_calls: 0,
      assess_calls: 0,
      report_calls: 0,
      paid_api_keys: {},
      trial_extensions: {}
    };
  }
}

function saveStats(s: Stats): void {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify(s)); } catch { /* /tmp reset is expected */ }
}

let stats = loadStats();

function incrementFreeTier(ip: string): void {
  const month = new Date().toISOString().slice(0, 7);
  if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
  stats.free_tier_calls_by_ip[ip][month] =
    (stats.free_tier_calls_by_ip[ip][month] ?? 0) + 1;
  saveStats(stats);
  saveFreeTierToRedis().catch(() => {});
}

function getEffectiveLimit(ip: string): number {
  const hasExtension = Object.values(stats.trial_extensions).some(ext => ext.ip === ip);
  return hasExtension ? FREE_TIER_LIMIT + TRIAL_EXTENSION_CALLS : FREE_TIER_LIMIT;
}

async function saveKeyToRedis(apiKey: string, record: PaidKeyRecord): Promise<void> {
  await redisSet(`${REDIS_PREFIX}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis(): Promise<void> {
  const keys = await redisKeys(`${REDIS_PREFIX}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${REDIS_PREFIX}:key:`, '');
      stats.paid_api_keys[apiKey] = record as PaidKeyRecord;
    }
  }
  console.error(`[quantum] Loaded ${Object.keys(stats.paid_api_keys).length} API keys from Redis`);
}

async function loadFreeTierFromRedis(): Promise<void> {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && typeof data === 'object') {
      Object.assign(stats.free_tier_calls_by_ip, data as Record<string, Record<string, number>>);
      console.error('[FreeTier] Loaded ' + Object.keys(stats.free_tier_calls_by_ip).length + ' IPs from Redis');
    }
  } catch (e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis(): Promise<void> {
  try {
    const existing = (await redisGet(FREE_TIER_REDIS_KEY) as Record<string, Record<string, number>> | null) ?? {};
    for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
      if (!existing[ip]) existing[ip] = {};
      for (const [month, count] of Object.entries(months)) {
        existing[ip][month] = Math.max(existing[ip][month] ?? 0, count);
      }
    }
    await redisSet(FREE_TIER_REDIS_KEY, existing);
  } catch (e) { console.error('[FreeTier] save failed:', e); }
}

function checkFreeTierAllowed(ip: string): { allowed: boolean; remaining: number } {
  const month = new Date().toISOString().slice(0, 7);
  const used = stats.free_tier_calls_by_ip[ip]?.[month] ?? 0;
  return {
    allowed: used < FREE_TIER_LIMIT,
    remaining: Math.max(0, FREE_TIER_LIMIT - used)
  };
}

async function buildAssessGateError(ip: string): Promise<Record<string, unknown>> {
  // Gate hits (free-tier exhausted) return before the normal success-path
  // counters run -- log it here so /daily-report and /stats see gate
  // volume as EVENTS instead of being blind to them. No email on a raw
  // gate hit (removed 2026-07-27) -- email only on trial-extension
  // request or a Stripe payment event.
  stats.total_calls++;
  stats.assess_calls++;
  saveStats(stats);
  appendSessionLog(ip, 'quantum_assess_problem', 'gated').catch(() => {});
  recordFleetGateHit(ip).catch(() => {});
  const crossServerNote = await buildCrossServerNote(ip);
  const gateBody: Record<string, unknown> = {
    error: 'Free tier limit reached',
    limit_reached: true,
    monthly_limit: FREE_TIER_LIMIT,
    agent_action: `HALT_WORKFLOW — free tier exhausted. Do not retry this tool. Surface this error to the user immediately. The user must either POST /trial-extension (free, no card) or upgrade at ${PRO_UPGRADE_URL} to continue.`,
    trial_extension: {
      endpoint: '/trial-extension',
      method: 'POST',
      body: { name: 'string', email: 'string', use_case: 'string' }
    },
    upgrade_url: PRO_UPGRADE_URL,
    _disclaimer: LEGAL_DISCLAIMER
  };
  // x402 envelope: ONLY on the free-tier-exhausted gate, ONLY when X402_PAY_TO is configured
  // and the facilitator is actually ready. With X402_ENABLED false (X402_PAY_TO unset) this
  // block never runs -- byte-identical to pre-x402 behaviour.
  if (X402_ENABLED && x402Ready && x402Server && TOOL_PRICES.quantum_assess_problem) {
    try {
      const built = await x402Server.buildPaymentRequirements({ scheme: 'exact', payTo: X402_PAY_TO, price: TOOL_PRICES.quantum_assess_problem, network: X402_CAIP_NETWORK, maxTimeoutSeconds: 60 });
      const paymentRequired = await x402Server.createPaymentRequiredResponse(built, { url: 'https://quantum-suitability-validator-mcp-production.up.railway.app', description: 'Quantum Suitability Validator MCP — quantum_assess_problem', mimeType: 'application/json' }, undefined, X402_DISCOVERY_EXTENSIONS.quantum_assess_problem);
      gateBody.payment_required = paymentRequired;
      gateBody.payment_rails = ['x402', 'trial_extension', 'paid_key'];
    } catch (e) { console.error('[x402] failed to build 402 envelope:', (e as Error).message); }
  }
  return gateBody;
}

function isPaidKey(key: string): boolean {
  return key.length > 0 && Object.prototype.hasOwnProperty.call(stats.paid_api_keys, key);
}

// Redis-independent circuit breaker for the email paths that remain after
// raw gate-hit emails were removed 2026-07-27 (trial-extension request +
// payment events only). Caps total sends server-wide so a flood of fake
// trial-extension requests can't exhaust the fleet's shared Resend quota
// even if Redis-backed dedup elsewhere is unavailable (Lesson 209).
const EMAIL_CIRCUIT_BREAKER_LIMIT = 20;
let emailBreakerCount = 0;
let emailBreakerWindowStart = Date.now();
function emailCircuitBreakerAllows(): boolean {
  const now = Date.now();
  if (now - emailBreakerWindowStart > 3600000) { emailBreakerWindowStart = now; emailBreakerCount = 0; }
  if (emailBreakerCount >= EMAIL_CIRCUIT_BREAKER_LIMIT) return false;
  emailBreakerCount++;
  return true;
}

// One trial extension per IP, ever (2026-08-19). Redis (trial_ext_granted:{ipSafe},
// no TTL) is the authoritative per-IP dedup and survives restarts. This breaker is a
// Redis-independent backstop: even if Redis is unreachable and the dedup check above
// silently passes every request, no more than 5 NEW grants can be issued per hour per
// server process.
const TRIAL_GRANT_HOURLY_CAP = 5;
let trialGrantBreakerCount = 0;
let trialGrantBreakerWindowStart = Date.now();
function trialGrantCircuitBreakerAllows(): boolean {
  const now = Date.now();
  if (now - trialGrantBreakerWindowStart > 3600000) { trialGrantBreakerWindowStart = now; trialGrantBreakerCount = 0; }
  if (trialGrantBreakerCount >= TRIAL_GRANT_HOURLY_CAP) return false;
  trialGrantBreakerCount++;
  return true;
}

function ipSafeKey(ip: string): string {
  return ip.replace(/:/g, '_').replace(/\s/g, '');
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  if (!emailCircuitBreakerAllows()) { console.error('[EmailBreaker] suppressed email to ' + to + ' — hourly cap reached'); return; }
  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: 'Kord Agencies <ojas@kordagencies.com>', to: [to], subject, html },
      { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
    );
  } catch { /* email failure is non-fatal */ }
}

function getStatsPayload(): Record<string, unknown> {
  const month = new Date().toISOString().slice(0, 7);
  let freeTierUnique = 0;
  let freeTierTotal = 0;
  const breakdown: Record<string, number> = {};
  for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
      breakdown[ip.slice(0, 10) + '...'] = months[month];
    }
  }
  return {
    total_calls: stats.total_calls,
    paid_calls: stats.paid_calls,
    free_calls: stats.total_calls - stats.paid_calls,
    assess_calls: stats.assess_calls,
    report_calls: stats.report_calls,
    free_tier_unique_ips: freeTierUnique,
    free_tier_total_calls: freeTierTotal,
    free_tier_breakdown: breakdown,
    paid_api_keys_count: Object.keys(stats.paid_api_keys).length,
    trial_extensions_granted: Object.keys(stats.trial_extensions).length,
    checked_at: nowISO()
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
function verifyStripeSignature(body: string, sig: string, secret: string): boolean {
  if (!secret || !sig) return false;
  try {
    const parts = sig.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=');
      if (k && v) acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const computed = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch { return false; }
}

function generateApiKey(): string {
  return `qsv_${crypto.randomBytes(24).toString('hex')}`;
}

async function findCheckoutSessionEmail(paymentIntentId: string): Promise<string | undefined> {
  const res = await axios.get('https://api.stripe.com/v1/checkout/sessions', {
    params: { payment_intent: paymentIntentId },
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const session = res.data?.data?.[0];
  return session?.customer_details?.email ?? session?.customer_email ?? undefined;
}

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] === 'charge.refunded') {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('[quantum] STRIPE_SECRET_KEY not set — cannot revoke key on refund');
      return;
    }
    const charge = (event['data'] as Record<string, unknown> | undefined)?.['object'] as Record<string, unknown> | undefined;
    const paymentIntentId = charge?.['payment_intent'] as string | undefined;
    if (!paymentIntentId) {
      console.error('[quantum] charge.refunded missing payment_intent — ignoring.');
      return;
    }
    try {
      const email = await findCheckoutSessionEmail(paymentIntentId);
      if (!email) {
        console.error('[quantum] No checkout session/email found for refunded payment_intent ' + paymentIntentId);
        return;
      }
      const revokedKey = Object.keys(stats.paid_api_keys).find(k => stats.paid_api_keys[k]?.email === email);
      if (!revokedKey) {
        console.error('[quantum] No API key found for ' + email + ' — refund received, nothing to revoke');
        return;
      }
      delete stats.paid_api_keys[revokedKey];
      await redisDelete(`${REDIS_PREFIX}:key:${revokedKey}`);
      saveStats(stats);
      console.error('[Webhook] API key revoked for ' + email + ' — refund received');
    } catch (err) {
      console.error('[quantum] charge.refunded handling error:', err);
    }
    return;
  }

  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
  const paymentLinkId = obj?.['payment_link'] as string | undefined;
  if (paymentLinkId && !ALLOWED_PAYMENT_LINK_IDS.includes(paymentLinkId)) {
    console.error('[stripe] Webhook received but payment link ' + paymentLinkId + ' not for this server — ignoring.');
    return;
  }
  const email = (obj?.['customer_email'] as string | undefined) ?? 'unknown';
  const plan = ((obj?.['metadata'] as Record<string, string> | undefined)?.['plan']) ?? 'pro';

  const apiKey = generateApiKey();
  const record: PaidKeyRecord = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
  stats.paid_api_keys[apiKey] = record;
  await saveKeyToRedis(apiKey, record);
  saveStats(stats);

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && email !== 'unknown' && emailCircuitBreakerAllows()) {
    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: 'Kord Agencies <ojas@kordagencies.com>',
          to: [email],
          subject: 'Your Quantum Suitability Validator Pro API Key',
          text:
            `Thank you for upgrading to Quantum Suitability Validator Pro.\n\n` +
            `Your API key: ${apiKey}\n\n` +
            `Add this as the x-api-key header in your MCP client configuration.\n\n` +
            `Pro access includes:\n` +
            `- Unlimited quantum_assess_problem calls\n` +
            `- Full quantum_readiness_report: formulation guidance, hardware fit, error budget, validation plan\n\n` +
            `Docs and integration guide: kordagencies.com\n\n` +
            `Kord Agencies Pte Ltd`
        },
        {
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch { /* email failure is non-fatal */ }
  }

  console.error(`[stripe] New ${plan} key provisioned for ${email}`);
}

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------
function validateEnv(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing required env var: ANTHROPIC_API_KEY');
  }
}

// ---------------------------------------------------------------------------
// Dependencies check
// ---------------------------------------------------------------------------
async function checkDependencies(): Promise<DependencyStatus[]> {
  const anthropicOk = Boolean(process.env.ANTHROPIC_API_KEY);
  return [
    {
      name: 'Anthropic API (claude-sonnet-4-6)',
      ok: anthropicOk,
      detail: anthropicOk ? undefined : 'ANTHROPIC_API_KEY not set'
    }
  ];
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------
const ASSESS_DESCRIPTION =
  'Analyzes a computational problem for quantum computing suitability. ' +
  'Call this BEFORE your agent escalates any quantum computing initiative to a committee, allocates budget, or routes to a quantum specialist — ' +
  'at the moment a computational problem is identified and no provider has been selected. ' +
  'Use this when a problem has been tagged as a potential quantum candidate and your agent needs an expert triage verdict before committing investigation resources. ' +
  'Returns four independent scores (scientific fit, hardware feasibility, advantage potential, commercial relevance) plus composite verdict. ' +
  'The free tool answers: "Is this worth further quantum investigation?" not "Has quantum advantage been demonstrated?" — ' +
  'a hydrogen-chain VQE has high scientific suitability even if commercial advantage is unproven. ' +
  'A NOT_QUANTUM_AMENABLE or PREMATURE verdict means route to classical compute immediately. ' +
  'Call quantum_readiness_report next if verdict is SCIENTIFICALLY_RECOMMENDED_NOW or COMMERCIALLY_RECOMMENDED_NOW.';

const REPORT_DESCRIPTION =
  'Generates a full quantum readiness report with hardware fit, qubit estimates, and validation plan. ' +
  'Call this BEFORE your agent selects a quantum provider or allocates quantum POC budget — ' +
  'immediately after quantum_assess_problem returns SCIENTIFICALLY_RECOMMENDED_NOW or COMMERCIALLY_RECOMMENDED_NOW. ' +
  'Use this when quantum_assess_problem has returned a positive verdict and your agent needs a detailed readiness report before presenting to a committee or selecting a provider. ' +
  'Pass profile=RESEARCH for research/academic contexts, ENTERPRISE for commercial deployment evaluation, INVESTOR for startup/portfolio assessment. ' +
  'Profile determines how the four scores are weighted — the same problem legitimately requires different verdicts by profile. ' +
  'Returns hardware requirements, qubit estimates, error correction needs, recommended providers, and advantage_claim_level. ' +
  'Do not call this tool if quantum_assess_problem returned PREMATURE or NOT_QUANTUM_AMENABLE.';

// ---------------------------------------------------------------------------
// Server card (Smithery required format)
// ---------------------------------------------------------------------------
function getServerCard(): ServerCard {
  return {
    serverInfo: { name: 'quantum-suitability-validator-mcp-server', version: VERSION },
    authentication: { required: false },
    tools: [
      {
        name: 'quantum_assess_problem',
        description: ASSESS_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            problem_description: {
              type: 'string',
              minLength: 20,
              maxLength: 5000,
              description: 'Description of the problem proposed for quantum computing. Minimum 20 characters.'
            },
            industry: {
              type: 'string',
              maxLength: 100,
              description: 'Industry or sector context (e.g. finance, logistics, pharma, energy)'
            },
            objective_type: {
              type: 'string',
              enum: ['optimisation', 'simulation', 'sampling', 'ml', 'cryptography', 'other'],
              description: 'Primary objective type'
            },
            current_classical_method: {
              type: 'string',
              maxLength: 500,
              description: 'Current classical algorithm or solver being used'
            },
            constraints_description: {
              type: 'string',
              maxLength: 1000,
              description: 'Description of problem constraints'
            },
            variables_estimate: {
              type: 'integer',
              minimum: 1,
              maximum: 10000000,
              description: 'Estimated number of decision variables'
            },
            response_format: {
              type: 'string',
              enum: ['markdown', 'json'],
              default: 'json',
              description: "Output format: 'json' (default) or 'markdown'"
            }
          },
          required: ['problem_description'],
          additionalProperties: false
        }
      },
      {
        name: 'quantum_readiness_report',
        description: REPORT_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            problem_description: {
              type: 'string',
              minLength: 20,
              maxLength: 5000,
              description: 'Description of the problem proposed for quantum computing. Minimum 20 characters.'
            },
            profile: {
              type: 'string',
              enum: ['RESEARCH', 'ENTERPRISE', 'INVESTOR'],
              description: 'Audience profile: RESEARCH (scientific weights), ENTERPRISE (commercial weights), INVESTOR (advantage evidence weights).'
            },
            industry: {
              type: 'string',
              maxLength: 100,
              description: 'Industry or sector context'
            },
            objective_type: {
              type: 'string',
              enum: ['optimisation', 'simulation', 'sampling', 'ml', 'cryptography', 'other'],
              description: 'Primary objective type'
            },
            current_classical_method: {
              type: 'string',
              minLength: 5,
              maxLength: 500,
              description: 'REQUIRED. Current classical algorithm or solver being used.'
            },
            constraints_description: {
              type: 'string',
              minLength: 5,
              maxLength: 1000,
              description: 'REQUIRED. Description of problem constraints.'
            },
            variables_estimate: {
              type: 'integer',
              minimum: 1,
              maximum: 10000000,
              description: 'Estimated number of decision variables'
            },
            success_metric: {
              type: 'string',
              maxLength: 500,
              description: 'Measurable success criterion vs baseline'
            },
            response_format: {
              type: 'string',
              enum: ['markdown', 'json'],
              default: 'json',
              description: "Output format: 'json' (default) or 'markdown'"
            }
          },
          required: ['problem_description', 'profile', 'current_classical_method', 'constraints_description'],
          additionalProperties: false
        }
      }
    ],
    resources: [],
    prompts: []
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'quantum-suitability-validator-mcp-server',
  version: VERSION
});

// Tool 1: quantum_assess_problem (free: 5/month per IP)
server.registerTool(
  'quantum_assess_problem',
  {
    title: 'Assess Quantum Problem Suitability',
    description: ASSESS_DESCRIPTION,
    inputSchema: AssessInputSchema,
    outputSchema: AssessOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    const ip = currentIP;
    if (process.env['TOOL_DISABLED_QUANTUM_ASSESS_PROBLEM'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(ip, 'quantum_assess_problem', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    // x402 rail -- only engages when a payment signature is actually attached. An absent or
    // invalid payment is NOT a rejection here; it falls straight through to the existing
    // free-tier/paid-key gate below, exactly as if no PAYMENT-SIGNATURE header existed.
    let paidViaX402 = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let x402Payment: { payload: unknown; requirements: unknown } | null = null;
    const paymentSignature = currentPaymentSignature;
    if (!paid && X402_ENABLED && paymentSignature) {
      if (!x402Ready) {
        // A real payment attempt landed during the async facilitator-init window. Fail closed --
        // never silently spend the caller's free tier on what was actually an attempted paid
        // call. Retryable: a fresh attempt after init completes will verify normally.
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Payment rail is still starting up. Retry in a few seconds.', agent_action: 'RETRY_IN_5_SEC', retryable: true, retry_after_ms: 5000, _disclaimer: LEGAL_DISCLAIMER }) }]
        };
      }
      const verified = await checkX402Payment(paymentSignature, 'quantum_assess_problem');
      if (verified) {
        paidViaX402 = true;
        x402Payment = verified;
      }
    }

    if (!paid && !paidViaX402) {
      const tierCheck = checkFreeTierAllowed(ip);
      if (!tierCheck.allowed) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(await buildAssessGateError(ip)) }]
        };
      }

      if (tierCheck.remaining <= 1) {
        console.error(`[quota] ${ip} has ${tierCheck.remaining} free call(s) remaining`);
      }
    }

    try {
      stats.total_calls++;
      stats.assess_calls++;
      if (paid) {
        stats.paid_calls++;
        if (stats.paid_api_keys[currentApiKey]) {
          stats.paid_api_keys[currentApiKey].calls++;
          stats.paid_api_keys[currentApiKey].last_seen = nowISO();
        }
      }

      let result;
      try {
        result = await runAssess(params);
      } catch (runErr) {
        if (paidViaX402 && x402Payment) {
          // SDK-idiomatic order: payment already verified above. Execute first; only settle
          // (charge) after a successful run. The tool threw -- cancel the verified-but-unsettled
          // payment so the reservation is released and the caller is not charged.
          try {
            const dispatcher = x402Server.createPaymentCancellationDispatcher(x402Payment.payload, x402Payment.requirements);
            await dispatcher.cancel({ reason: 'handler_threw', error: (runErr as Error).message });
          } catch (ce) { console.error('[x402] cancel() failed:', (ce as Error).message); }
          console.error('[x402] tool threw — verified payment canceled, not settled, not charged:', (runErr as Error).message);
        }
        throw runErr;
      }

      if (result.error) {
        saveStats(stats);
        if (paidViaX402 && x402Payment) {
          try {
            const dispatcher = x402Server.createPaymentCancellationDispatcher(x402Payment.payload, x402Payment.requirements);
            await dispatcher.cancel({ reason: 'tool_returned_error' });
          } catch (ce) { console.error('[x402] cancel() failed:', (ce as Error).message); }
          console.error('[x402] tool returned an error — verified payment canceled, not settled, not charged');
        }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
        };
      }

      let settleResult: { success?: boolean; errorReason?: unknown; errorMessage?: unknown } | null = null;
      if (paidViaX402 && x402Payment) {
        try {
          settleResult = await x402Server.settlePayment(x402Payment.payload, x402Payment.requirements);
        } catch (e) {
          settleResult = { success: false, errorMessage: (e as Error).message };
        }
        if (!settleResult || !settleResult.success) {
          // Tool ran successfully but settlement failed after the fact -- never deliver a result
          // we couldn't charge for. Discard the result, log loudly (Redis-visible), tell the
          // caller it's safe to retry (a fresh attempt will re-verify and re-settle from scratch).
          await logX402SettleFailure({ tool: 'quantum_assess_problem', reason: settleResult?.errorReason, message: settleResult?.errorMessage });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Payment settlement failed after tool execution. No result delivered, no charge applied. Safe to retry.', agent_action: 'RETRY', retryable: true }) }]
          };
        }
        redisIncr(REDIS_PREFIX + ':x402_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
        // Distinct, louder alert for a real x402 settlement -- this is the fleet's key signal
        // for a real external agent-native payment. Never blocks the response; failure here
        // must never affect the already-settled, already-delivered result.
        sendEmail(
          'ojas@kordagencies.com',
          '[x402 SETTLEMENT] Quantum — real payment received',
          '<p><b>Tool:</b> quantum_assess_problem</p><p><b>Network:</b> ' + X402_CAIP_NETWORK + '</p><p><b>Time:</b> ' + nowISO() + '</p><p><b>Settlement:</b> ' + JSON.stringify(settleResult) + '</p>'
        ).catch((e: Error) => console.error('[x402] settlement alert email failed:', e.message));
      } else if (!paid) {
        incrementFreeTier(ip); // saves stats + Redis internally
      } else {
        saveStats(stats);
      }
      if (paidViaX402) saveStats(stats);
      redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
      appendSessionLog(ip, 'quantum_assess_problem').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

      const output = result.output!;

      const effectivelyPaid = paid || paidViaX402;
      const remaining = effectivelyPaid ? null : checkFreeTierAllowed(ip).remaining;
      output.calls_remaining = effectivelyPaid ? 'unlimited' : Math.max(0, remaining ?? 0);
      if (!effectivelyPaid && remaining !== null && remaining <= 1 && remaining > 0) {
        const effectiveLimit = getEffectiveLimit(ip);
        output._upgrade_notice =
          `Warning: ${remaining} free assessment(s) remaining this month (limit: ${effectiveLimit}). ` +
          output._upgrade_notice;
      }

      const text =
        params.response_format === 'markdown'
          ? formatAssessMarkdown(output)
          : JSON.stringify(output, null, 2);

      const finalText =
        text.length > 25000
          ? text.slice(0, 25000) + '\n\n[Response truncated.]'
          : text;

      return {
        content: [{ type: 'text' as const, text: finalText }],
        structuredContent: output as unknown as Record<string, unknown>
      };
    } catch (_err) {
      saveStats(stats);
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Assessment timed out. The problem description may be too complex for a single call. Try breaking it into a more specific, narrower problem statement.',
            agent_action: 'RETRY_WITH_SIMPLER_INPUT',
            retryable: true
          })
        }]
      };
    }
  }
);

// Tool 2: quantum_readiness_report (paid only)
server.registerTool(
  'quantum_readiness_report',
  {
    title: 'Full Quantum Readiness Report',
    description: REPORT_DESCRIPTION,
    inputSchema: ReportInputSchema,
    outputSchema: ReportOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    if (process.env['TOOL_DISABLED_QUANTUM_READINESS_REPORT'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(currentIP, 'quantum_readiness_report', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    if (!paid) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Pro API key required',
              likely_cause:
                'quantum_readiness_report is a paid-only tool. No valid x-api-key header was provided.',
              agent_action:
                'Inform user that quantum_readiness_report requires a Pro subscription. ' +
                `Upgrade at ${PRO_UPGRADE_URL} for the full Quantum Readiness Report including ` +
                'formulation path, hardware family fit, error budget viability, and validation plan.',
              upgrade_url: PRO_UPGRADE_URL,
              fallback_tool: 'quantum_assess_problem',
              retryable: false,
              _disclaimer: LEGAL_DISCLAIMER
            })
          }
        ]
      };
    }

    try {
      stats.total_calls++;
      stats.report_calls++;
      stats.paid_calls++;
      if (stats.paid_api_keys[currentApiKey]) {
        stats.paid_api_keys[currentApiKey].calls++;
        stats.paid_api_keys[currentApiKey].last_seen = nowISO();
      }

      const result = await runReport(params);

      if (result.error) {
        saveStats(stats);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
        };
      }

      saveStats(stats);
      redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
      appendSessionLog(currentIP, 'quantum_readiness_report').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

      const output = result.output!;

      const text =
        params.response_format === 'markdown'
          ? formatReportMarkdown(output)
          : JSON.stringify(output, null, 2);

      const finalText =
        text.length > 25000
          ? text.slice(0, 25000) + '\n\n[Response truncated.]'
          : text;

      return {
        content: [{ type: 'text' as const, text: finalText }],
        structuredContent: output as unknown as Record<string, unknown>
      };
    } catch (_err) {
      saveStats(stats);
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Assessment timed out. The problem description may be too complex for a single call. Try breaking it into a more specific, narrower problem statement.',
            agent_action: 'RETRY_WITH_SIMPLER_INPUT',
            retryable: true
          })
        }]
      };
    }
  }
);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
async function runHTTP(): Promise<void> {
  validateEnv();

  const app = express();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key, x-owner-key'
  };

  // Webhook must be registered before express.json() to receive raw body for signature verification
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const sig = req.headers['stripe-signature'] as string;
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
      if (!verifyStripeSignature(req.body.toString(), sig, secret)) {
        res.status(400).set(cors).json({ error: 'Invalid signature' });
        return;
      }
      handleStripeEvent(JSON.parse(req.body.toString()) as Record<string, unknown>).catch(err =>
        console.error('[stripe] handler error:', err)
      );
      res.set(cors).json({ received: true });
    }
  );

  app.use(express.json());

  app.options('*', (_req, res) => { res.status(200).set(cors).end(); });

  app.all('/health', (_req, res) => {
    res.set(cors).json({ status: 'ok', version: VERSION, service: 'quantum-suitability-validator-mcp-server' });
  });

  app.all('/ready', (_req, res) => {
    const ok = Boolean(process.env.ANTHROPIC_API_KEY);
    res.status(ok ? 200 : 503).set(cors).json({
      status: ok ? 'ready' : 'not_ready',
      version: VERSION,
      checks: { anthropic_api: ok }
    });
  });

  app.get('/deps', async (_req, res) => {
    const deps = await checkDependencies();
    res.set(cors).json({ checked_at: nowISO(), dependencies: deps });
  });

  app.get('/stats', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    res.set(cors).json(getStatsPayload());
  });

  // Unauthenticated machine-readable track record -- for agent orchestrators
  // evaluating server trustworthiness, not for humans. No stats-key required.
  app.get('/public-stats', (_req, res) => {
    void (async () => {
      const [lifetimeCallsRaw, heartbeatCountRaw, monitoringStart] = await Promise.all([
        redisGet(LIFETIME_CALLS_REDIS_KEY),
        redisGet(UPTIME_HEARTBEAT_KEY),
        redisGet(UPTIME_MONITORING_START_KEY)
      ]);
      const lifetimeCalls = (lifetimeCallsRaw as number | null) ?? 0;
      const heartbeatCount = (heartbeatCountRaw as number | null) ?? 0;
      const monitoringStartTime = monitoringStart ? new Date(monitoringStart as string).getTime() : Date.now();
      const elapsedMs = Math.max(1, Date.now() - monitoringStartTime);
      const uptimePct = Math.min(100, Math.round((heartbeatCount * UPTIME_HEARTBEAT_INTERVAL_MS / elapsedMs) * 1000) / 10);
      res.set(cors).json({
        server: 'quantum-suitability-validator-mcp-server',
        version: VERSION,
        first_deployed: FIRST_DEPLOYED,
        total_lifetime_tool_calls: lifetimeCalls,
        uptime_percentage: uptimePct,
        uptime_monitoring_since: monitoringStart ?? nowISO()
      });
    })();
  });

  app.get('/session-log', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions: Array<Record<string, unknown>> = [];
      for (const key of keys) {
        const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp ?? '', last_call: calls[calls.length - 1]?.timestamp ?? '' });
      }
      sessions.sort((a, b) => String(b.first_call).localeCompare(String(a.first_call)));
      res.set(cors).json(sessions);
    })();
  });

  app.get('/.well-known/mcp/server-card.json', (_req, res) => {
    res.set(cors).json(getServerCard());
  });

  app.get('/.well-known/glama.json', (_req, res) => {
    res.set(cors).json({ "$schema": "https://glama.ai/mcp/schemas/connector.json", "maintainers": [{ "email": "ojas@kordagencies.com" }] });
  });

  // Trial extension endpoint
  app.post('/trial-extension', async (req, res) => {
    const { name, email, use_case } = req.body as { name?: string; email?: string; use_case?: string };
    if (!name || !email) {
      res.status(400).set(cors).json({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' });
      return;
    }
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';
    const ipGrantKey = REDIS_PREFIX + ':trial_ext_granted:' + ipSafeKey(ip);

    // One trial extension per IP, ever. IP is the authoritative key -- never
    // name/email, both are attacker-controlled and trivially rotated (this
    // server had 3 grants from a single IP under 3 different emails before
    // this fix). Redis has no TTL on this key, so a grant issued once is
    // permanent regardless of process restarts.
    const alreadyGrantedForIp = await redisGet(ipGrantKey);
    if (alreadyGrantedForIp) {
      res.status(200).set(cors).json({
        granted: false,
        error: 'This IP address has already received its one-time trial extension.',
        message: 'Only one trial extension is available per IP address, and it has already been used. Upgrade to continue: ' + PRO_UPGRADE_URL,
        upgrade_url: PRO_UPGRADE_URL,
        agent_action: 'HALT_WORKFLOW — trial extension already used for this IP. Do not retry /trial-extension from this IP under a different name or email. Direct the user to the paid upgrade path.'
      });
      return;
    }

    // Redis-independent backstop -- caps new grants at 5/hr/server even if
    // Redis is unreachable and the check above can't be trusted.
    if (!trialGrantCircuitBreakerAllows()) {
      res.status(200).set(cors).json({
        granted: false,
        error: 'Trial extension grants are temporarily rate-limited on this server.',
        message: 'Please try again in a few minutes, or upgrade now: ' + PRO_UPGRADE_URL,
        upgrade_url: PRO_UPGRADE_URL,
        agent_action: 'RETRY_LATER_OR_UPGRADE'
      });
      return;
    }

    const emailKey = 'trial:' + email.toLowerCase().trim();
    if (stats.trial_extensions[emailKey]) {
      res.status(409).set(cors).json({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' });
      return;
    }
    const month = new Date().toISOString().slice(0, 7);
    if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
    const currentCalls = stats.free_tier_calls_by_ip[ip][month] ?? 0;
    stats.free_tier_calls_by_ip[ip][month] = Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS);
    stats.trial_extensions[emailKey] = { name, email, use_case: use_case ?? '', ip, granted_at: nowISO() };
    saveStats(stats);
    await redisSet(REDIS_PREFIX + ':trial:' + email.toLowerCase().trim(), { name, email, use_case: use_case ?? '', ip, timestamp: nowISO(), server: 'quantum-suitability-validator-mcp-server' });
    await redisSet(ipGrantKey, { name, email, ip, granted_at: nowISO() }); // no TTL -- one per IP, ever
    // 24h follow-up record -- processed by /process-trial-followups (fleet cron)
    await redisSet(REDIS_PREFIX + ':followup:' + email.toLowerCase().trim(), { email, name, server: 'quantum-suitability-validator-mcp-server', granted_at: nowISO(), sent: false });
    await sendEmail(
      'ojas@kordagencies.com',
      'Quantum Suitability Validator -- Trial Extension: ' + name,
      '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case ?? 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>'
    );
    await sendEmail(
      email,
      TRIAL_EXTENSION_CALLS + ' extra free calls added -- Quantum Suitability Validator MCP',
      '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using Quantum Suitability Validator MCP right now -- no action needed.</p><p>When you need more, Pro access is available at: ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>'
    );
    res.set(cors).json({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', upgrade_url: PRO_UPGRADE_URL });
  });

  // Fleet cron hits this hourly. Sends exactly one follow-up email per email
  // address, 24h after a trial extension was granted, unless that email has
  // since picked up a paid key on this server.
  app.post('/process-trial-followups', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(REDIS_PREFIX + ':followup:*');
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      let processed = 0, sent = 0, skippedPaid = 0;
      for (const key of keys) {
        const record = await redisGet(key) as { email: string; name: string; granted_at: string; sent: boolean; sent_at?: string } | null;
        if (!record || record.sent) continue;
        if (Date.now() - new Date(record.granted_at).getTime() < TWENTY_FOUR_HOURS_MS) continue;
        processed++;
        const emailNorm = (record.email || '').toLowerCase().trim();
        const hasPaidKey = Object.values(stats.paid_api_keys).some(r => (r.email || '').toLowerCase().trim() === emailNorm);
        if (hasPaidKey) {
          skippedPaid++;
        } else {
          await sendEmail(record.email, 'Quantum Suitability Validator MCP -- quantum triage will block your investigation workflow again without an upgrade',
            '<p>Hi ' + record.name + ',</p><p>Your trial extension on Quantum Suitability Validator MCP was granted 24 hours ago. Once those extra calls run out, quantum triage stops and any investigation workflow that depends on it pauses until you upgrade.</p><p>Upgrade now: ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>');
          sent++;
        }
        record.sent = true;
        record.sent_at = nowISO();
        await redisSet(key, record);
      }
      res.set(cors).json({ checked: keys.length, processed, emails_sent: sent, skipped_already_paid: skippedPaid });
    })();
  });

  // Daily report -- JSON only, for Bizfile aggregation
  app.post('/daily-report', async (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const cutoffMs = Date.now() - 86400000;
    const month = new Date().toISOString().slice(0, 7);

    let limitHits = 0;
    for (const months of Object.values(stats.free_tier_calls_by_ip)) {
      if ((months[month] ?? 0) >= FREE_TIER_LIMIT) limitHits++;
    }

    let trialCount = 0;
    for (const record of Object.values(stats.trial_extensions)) {
      if (record.granted_at && record.granted_at >= since24h) trialCount++;
    }

    let paidCount = 0;
    for (const record of Object.values(stats.paid_api_keys)) {
      const ts = record.created_at ? new Date(record.created_at).getTime() : 0;
      if (ts >= cutoffMs) paidCount++;
    }

    const sessionKeys = await redisKeys(`${REDIS_PREFIX}:session:*:${today}`);
    const toolBreakdown: Record<string, number> = {};
    let calls24h = 0;
    let gateHits24h = 0;
    for (const key of sessionKeys) {
      const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string; tier?: string }> | null) ?? [];
      calls.forEach(c => {
        if (!c.tool) return;
        if (c.tier === 'gated') { gateHits24h++; return; }
        toolBreakdown[c.tool] = (toolBreakdown[c.tool] ?? 0) + 1;
        calls24h++;
      });
    }
    const unique24h = sessionKeys.length;

    res.set(cors).json({
      server: 'quantum-suitability-validator-mcp',
      date: today,
      calls_24h: calls24h,
      gate_hits_24h: gateHits24h,
      unique_ips_24h: unique24h,
      limit_hits: limitHits,
      trial_extensions: trialCount,
      paid_conversions: paidCount,
      tool_breakdown: toolBreakdown
    });
  });

  app.post('/mcp', async (req, res) => {
    currentIP =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      '127.0.0.1';
    currentApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
    currentOwnerKey = (req.headers['x-owner-key'] as string | undefined) ?? '';
    currentPaymentSignature = (req.headers['payment-signature'] as string | undefined) ?? '';

    const isToolDisabled = process.env['TOOL_DISABLED_QUANTUM_ASSESS_PROBLEM'] === 'true';
    // A request carrying a payment-signature header is deferred to the tool handler, which does
    // the real x402 verify (and, if it fails or isn't ready, falls through to this same
    // free-tier gate on its own) -- this pre-check must not hard-block it here first.
    const hasPaymentAttempt = X402_ENABLED && !!currentPaymentSignature;
    if (!isToolDisabled && req.body?.method === 'tools/call' && req.body?.params?.name === 'quantum_assess_problem' && !isPaidKey(currentApiKey) && !isOwner() && !hasPaymentAttempt) {
      if (!checkFreeTierAllowed(currentIP).allowed) {
        res.status(402).set(cors).json({
          jsonrpc: '2.0',
          id: req.body.id,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify(await buildAssessGateError(currentIP)) }] }
        });
        return;
      }
    }

    res.set(cors);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => { transport.close().catch(() => { /* ignore */ }); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () => {
    void (async () => {
      await loadApiKeysFromRedis();
      await loadFreeTierFromRedis();
      await initUptimeTracking(UPTIME_HEARTBEAT_KEY, UPTIME_MONITORING_START_KEY, UPTIME_HEARTBEAT_INTERVAL_MS);
      console.error(`quantum-suitability-validator-mcp-server running on http://localhost:${port}/mcp`);
    })();
  });
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  validateEnv();
  currentApiKey = process.env.API_KEY ?? '';
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('quantum-suitability-validator-mcp-server running via stdio');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const transportMode = process.env.TRANSPORT ?? 'http';
if (transportMode === 'stdio') {
  runStdio().catch(err => { console.error(err); process.exit(1); });
} else {
  runHTTP().catch(err => { console.error(err); process.exit(1); });
}
