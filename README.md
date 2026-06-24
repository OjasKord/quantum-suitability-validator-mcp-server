[![smithery badge](https://smithery.ai/badge/OjasKord/quantum-suitability-validator-mcp-server)](https://smithery.ai/servers/OjasKord/quantum-suitability-validator-mcp-server)

# Quantum Suitability Validator MCP

[![ToolRank](https://toolrank.dev/badge/dominant.svg)](https://toolrank.dev/ranking)

MCP server that screens quantum computing POC proposals against expert decision rules -- before your agent escalates any initiative to a committee, allocates budget, or routes to a specialist.

## What it does

Enterprise innovation agents and R&D workflow agents process backlogs of proposed technology initiatives tagged as potential quantum computing candidates. Before escalating any candidate to a human committee, allocating POC budget, or routing to a quantum specialist, the agent calls `quantum_assess_problem` to produce an auditable triage verdict.

This server is **refusal-first by design**. It downgrades or refuses more often than it approves. Every verdict is auditable and machine-readable.

## Tools

### `quantum_assess_problem` (Free: 5/month, no key required)

Screens a quantum computing proposal using an expert-validated four-dimensional scoring framework. Returns:

- `verdict`: SCIENTIFICALLY_RECOMMENDED_NOW | COMMERCIALLY_RECOMMENDED_NOW | INVESTIGATE_FURTHER | PREMATURE | NOT_QUANTUM_AMENABLE
- `four_scores`: scientific_fit (40% weight), hardware_feasibility (25%), advantage_potential (25%), commercial_relevance (10%), composite -- four independent 0.0-1.0 scores so a scientifically valid investigation is never confused with proven commercial advantage
- `advantage_claim_level`: NONE | HYPOTHESISED | EXPERIMENTAL_SIGNAL | BENCHMARK_SUPPORTED | PRODUCTION_VALIDATED
- `suitability_score`: 0.0-1.0 (equal to four_scores.composite)
- `confidence_score`: 0.0-1.0
- `problem_class`: combinatorial_optimisation | portfolio_optimisation | molecular_simulation | ml_kernel | cryptography_pqc | sampling_monte_carlo | other
- `dominant_blockers`: specific reasons why the problem fails screening
- `hype_flags`: detected hype language patterns
- `baseline_question`: always "What is your classical baseline today, and what metric must improve for this to matter?"
- `next_best_action`: specific actionable recommendation
- `agent_action`: ESCALATE_TO_POC | ROUTE_TO_SIMULATOR | DEFINE_BASELINE_FIRST | REJECT | REQUEST_MORE_INFORMATION

### `quantum_readiness_report` (Pro only)

Full auditable Quantum Readiness Report, weighted by audience profile (RESEARCH, ENTERPRISE, or INVESTOR -- the same problem legitimately scores differently by profile). Everything from `quantum_assess_problem` plus:

- `recommended_workflow`: CLASSICAL_ONLY | HYBRID | SIMULATOR_ONLY | ANNEALING_PATH | GATE_MODEL_VARIATIONAL | INSUFFICIENT_INFORMATION
- `formulation_guidance`: QUBO/Ising/variational suitability, estimated binary variables, penalty dominance risk
- `hardware_recommendations`: hardware family fit scores with access routes (D-Wave Leap, IBM Cloud, IonQ Cloud)
- `error_budget_assessment`: viability against current noise floors
- `classical_baseline_assessment`: baseline strength and minimum benchmark requirement
- `validation_plan`: ordered steps for technical review board submission
- `refusal_reason`: populated when the report declines to recommend a path forward
- `commercial_reality_statement`: populated for ENTERPRISE and INVESTOR profiles -- states plainly that production advantage over classical has not yet been broadly demonstrated

## Connect

### HTTP (Railway -- no install)
```json
{"type": "http", "url": "https://quantum-suitability-validator-mcp-production.up.railway.app"}
```

### stdio (npm -- requires ANTHROPIC_API_KEY)
```bash
npx quantum-suitability-validator-mcp
```

## Harness Integration

Note: this server exposes tools at `/mcp` not the root URL.

### Claude Code / Claude Desktop (.mcp.json)
```json
{
  "mcpServers": {
    "quantum-suitability-validator": {
      "type": "http",
      "url": "https://quantum-suitability-validator-mcp-production.up.railway.app/mcp"
    }
  }
}
```

### LangChain (Python)
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({
    "quantum-suitability-validator": {
        "url": "https://quantum-suitability-validator-mcp-production.up.railway.app/mcp",
        "transport": "http"
    }
})
tools = await client.get_tools()
```

### OpenAI Agents SDK (Python)
```python
from agents import Agent, HostedMCPTool
agent = Agent(
    name="Assistant",
    tools=[HostedMCPTool(tool_config={
        "type": "mcp",
        "server_label": "quantum-suitability-validator",
        "server_url": "https://quantum-suitability-validator-mcp-production.up.railway.app/mcp",
        "require_approval": "never"
    })]
)
```

### LangGraph
Same as LangChain above — langchain-mcp-adapters works with LangGraph natively.

## Pricing

- **Free**: 5 `quantum_assess_problem` calls/month per IP -- no API key required
- **Pro**: $199/month -- unlimited `quantum_assess_problem` + full `quantum_readiness_report`
- **Enterprise**: $499/month -- volume + SLA

Upgrade: [kordagencies.com](https://kordagencies.com)

## Legal

AI-assisted triage -- NOT a substitute for experimental physicist review. Results are for informational and planning purposes only and do not constitute expert quantum computing advice. Full terms: kordagencies.com/terms.html

Kord Agencies Pte Ltd, Singapore
