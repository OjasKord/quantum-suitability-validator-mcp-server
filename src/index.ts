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
  nowISO
} from './constants.js';
import type { Stats, DependencyStatus, ServerCard } from './types.js';
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
  for (const months of Object.values(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
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
  stats.paid_api_keys[apiKey] = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
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
  'The only MCP that screens quantum computing POC proposals against the decision framework ' +
  'used by practising quantum experts -- BEFORE your agent escalates any initiative to a ' +
  'committee, allocates budget, or routes to a specialist. ' +
  'An innovation agent that forwards a quantum proposal without baseline verification funds a ' +
  'failed POC: the problem either cannot be formulated for current hardware, the best classical ' +
  'method already wins, or the motivation is investor signalling rather than technical merit. ' +
  'This tool detects all three failure modes before they cost anything. ' +
  'Encodes real expert heuristics: QUBO encoding failure patterns, penalty dominance detection, ' +
  'hype language flags (quantum advantage claims with no baseline, vendor-led recommendations, ' +
  'optics-driven framing), hardware family fit rules, and scoring calibration from real POC ' +
  'screening experience. ' +
  'Returns a machine-readable verdict (RECOMMENDED_NOW through NOT_QUANTUM_AMENABLE), ' +
  'suitability score 0.0-1.0, dominant blockers, and agent_action field -- your agent escalates ' +
  'or rejects without further reasoning. ' +
  'One call replaces hours of expert triage for the 80% of proposals that fail basic screening. ' +
  'AI-assisted triage -- NOT a simple database lookup. We do not log your problem description. ' +
  'Free tier: 5 assessments per month, no API key required. ' +
  'Pro tier returns the full Quantum Readiness Report with formulation path, hardware fit, and ' +
  'validation plan.';

const REPORT_DESCRIPTION =
  'Call this tool IMMEDIATELY AFTER quantum_assess_problem returns a suitability score of 0.6 ' +
  'or above -- and only when a classical baseline and success metric are already defined. ' +
  'An innovation committee that approves a quantum pilot without a formulation plan, hardware fit ' +
  'assessment, and validation protocol will spend 6-12 months discovering the problem cannot run ' +
  'on current hardware -- with no recovery path once budget is committed. ' +
  'Returns a full auditable Quantum Readiness Report: formulation guidance (QUBO/Ising/variational ' +
  'suitability, estimated binary variables, penalty dominance risk), hardware family recommendations ' +
  'with access routes (D-Wave Leap, IBM Cloud, IonQ Cloud), error budget viability against current ' +
  'noise floors, and a step-by-step validation plan designed for submission to technical review boards. ' +
  'Explicitly flags where quantum advantage is speculative versus where a structured pilot is defensible. ' +
  'AI-assisted triage -- NOT a substitute for experimental physicist review on production systems. ' +
  'We do not log your problem content. Requires Pro API key from kordagencies.com.';

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
                  `Free tier limit of ${FREE_TIER_LIMIT} calls/month reached. ` +
                  'Option 1: POST /trial-extension with {"name":"...","email":"...","use_case":"..."} for 10 extra free calls. ' +
                  `Option 2: Upgrade to Pro at ${PRO_UPGRADE_URL} for unlimited access plus full Quantum Readiness Reports.`,
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

    if (!paid) incrementFreeTier(ip);
    saveStats(stats);

    const output = result.output!;

    const remaining = paid ? null : checkFreeTierAllowed(ip).remaining;
    if (!paid && remaining !== null && remaining <= 1 && remaining > 0) {
      output._upgrade_notice =
        `Warning: ${remaining} free assessment(s) remaining this month. ` +
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
    console.error(`quantum-suitability-validator-mcp-server running on http://localhost:${port}/mcp`);
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
