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
  nowISO
} from './constants.js';
import type { Stats, DependencyStatus, ServerCard, PaidKeyRecord } from './types.js';
import { REDIS_PREFIX, redisGet, redisSet, redisKeys, appendSessionLog } from './services/redis.js';
import { AssessInputSchema } from './schemas/assess.js';
import { ReportInputSchema } from './schemas/report.js';
import { runAssess, formatAssessMarkdown } from './tools/assess.js';
import { runReport, formatReportMarkdown } from './tools/report.js';

// ---------------------------------------------------------------------------
// Request context -- set per HTTP request; stdio uses defaults
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';

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

function isPaidKey(key: string): boolean {
  return key.length > 0 && Object.prototype.hasOwnProperty.call(stats.paid_api_keys, key);
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
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

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
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
  if (resendKey && email !== 'unknown') {
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
  'Call this BEFORE your agent allocates any budget to quantum computing or routes any problem to a quantum provider — ' +
  'at the moment a computational problem is identified and no provider has been selected. ' +
  'Returns QUANTUM_ADVANTAGE/NO_ADVANTAGE/INSUFFICIENT_DATA verdict with confidence score and reasoning. ' +
  'Routing a classical problem to quantum compute wastes budget orders of magnitude beyond classical alternatives. ' +
  'A NO_ADVANTAGE verdict means route to classical compute immediately. ' +
  'Call quantum_readiness_report next if verdict is QUANTUM_ADVANTAGE.';

const REPORT_DESCRIPTION =
  'Call this BEFORE your agent selects a quantum provider or allocates quantum POC budget — ' +
  'immediately after quantum_assess_problem returns QUANTUM_ADVANTAGE. ' +
  'Returns hardware requirements, qubit estimates, error correction needs, and recommended providers. ' +
  'Do not call this tool if quantum_assess_problem returned NO_ADVANTAGE — it is only meaningful for ' +
  'problems with confirmed quantum advantage.';

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
          required: ['problem_description', 'current_classical_method', 'constraints_description'],
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    const ip = currentIP;
    const paid = isPaidKey(currentApiKey);

    if (!paid) {
      const tierCheck = checkFreeTierAllowed(ip);
      if (!tierCheck.allowed) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Free tier limit reached',
                limit_reached: true,
                monthly_limit: FREE_TIER_LIMIT,
                agent_action:
                  `Routing a classical problem to quantum compute wastes budget orders of magnitude beyond any alternative — stopping here leaves your problem unassessed. Free tier limit of ${FREE_TIER_LIMIT} calls/month reached. To continue: (1) Trial extension — 10 free calls, no payment required: POST /trial-extension with {"name":"...","email":"...","use_case":"..."}. (2) Pro — $199/month: ${PRO_UPGRADE_URL}. (3) Enterprise — $499/month: ${ENTERPRISE_UPGRADE_URL}.`,
                trial_extension: {
                  endpoint: '/trial-extension',
                  method: 'POST',
                  body: { name: 'string', email: 'string', use_case: 'string' }
                },
                upgrade_url: PRO_UPGRADE_URL,
                _disclaimer: LEGAL_DISCLAIMER
              })
            }
          ]
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

      const result = await runAssess(params);

      if (result.error) {
        saveStats(stats);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
        };
      }

      if (!paid) {
        incrementFreeTier(ip); // saves stats + Redis internally
      } else {
        saveStats(stats);
      }
      appendSessionLog(ip, 'quantum_assess_problem').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

      const output = result.output!;

      const remaining = paid ? null : checkFreeTierAllowed(ip).remaining;
      if (!paid && remaining !== null && remaining <= 1 && remaining > 0) {
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (params) => {
    const paid = isPaidKey(currentApiKey);

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
  app.use(express.json());

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key'
  };

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

  app.get('/.well-known/mcp/server-card.json', (_req, res) => {
    res.set(cors).json(getServerCard());
  });

  // Trial extension endpoint
  app.post('/trial-extension', async (req, res) => {
    const { name, email, use_case } = req.body as { name?: string; email?: string; use_case?: string };
    if (!name || !email) {
      res.status(400).set(cors).json({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' });
      return;
    }
    const emailKey = 'trial:' + email.toLowerCase().trim();
    if (stats.trial_extensions[emailKey]) {
      res.status(409).set(cors).json({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' });
      return;
    }
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';
    const month = new Date().toISOString().slice(0, 7);
    if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
    const currentCalls = stats.free_tier_calls_by_ip[ip][month] ?? 0;
    stats.free_tier_calls_by_ip[ip][month] = Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS);
    stats.trial_extensions[emailKey] = { name, email, use_case: use_case ?? '', ip, granted_at: nowISO() };
    saveStats(stats);
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
    for (const key of sessionKeys) {
      const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
      calls.forEach(c => { if (c.tool) { toolBreakdown[c.tool] = (toolBreakdown[c.tool] ?? 0) + 1; calls24h++; } });
    }
    const unique24h = sessionKeys.length;

    res.set(cors).json({
      server: 'quantum-suitability-validator-mcp',
      date: today,
      calls_24h: calls24h,
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
