# GrowthLoop — project instructions for Claude Code

## What we are building
GrowthLoop: a multi-agent "marketing team in a product" for small businesses in Cameroon.
Closed loop: analyse existing content, ads and sales -> critique the findings -> recommend
-> create posts -> brand review -> queue for publishing -> learn into memory -> next run is smarter.
The first run of a new client is always an AUDIT of the content the company already has
(posts carry `origin` = `existing` | `app`).
Hackathon: Open Agent Hackathon 2026, Track 3 (Reasoning Architecture).
Deadline: 27 Oct 2026, 23:45 UTC. Scope must stay small and working.

## Hard requirements (disqualification if missing)
- Zetaris is the data layer: the agents read business data ONLY through Zetaris (REST API).
- At least one Meterless Engine in a working feature, with a passing test: H-MEM (memory).
- Meterless Nightshift is the primary AI provider: every model call goes through it.
- At least two distinct agents, with critique/validation/retry visible in logs.
- No hardcoded outputs, no fabricated logs, no claims in the README that the code does not do.
- SAMPLE_MODE=true runs the real agent logic on local CSVs without Zetaris/Nightshift.

## Workflow rules (important)
- Work ONE step at a time. Only do the step I give you.
- At the end of each step: list the files created/changed, give the exact commands to test,
  then STOP and wait for me to say "next". Do not start the next step on your own.
- Ask before adding any dependency. Prefer Node built-ins.
- Never touch anything outside this repository (especially ~/zetaris-platform).

## Stack
- TypeScript, Node >= 20, run with `tsx` (no build step). ES modules.
- HTTP server: node:http. Tests: node:test via `tsx --test`. No web framework.
- Minimal dependencies: tsx (+ cross-env for scripts if needed).

## Coding principles
- Small single-purpose modules. Typed interfaces. Pure functions where possible (easy to test).
- Each external service behind an adapter in src/adapters/ (zetaris.ts, nightshift.ts);
  agents never call fetch directly.
- One config module (src/config.ts) reads environment variables; nowhere else reads process.env.
- Every external call has a timeout, bounded retries with backoff, and a clear error type.
- Agent loops are bounded (max 2 critique revisions, max 1 brand revision).
- Errors return structured JSON, never a stack trace or a hang.
- Code comments explain WHY, briefly.

## Security
- Secrets only from environment variables (.env, gitignored). Ship .env.example with placeholders.
- Never log, print or return secrets; redact tokens in logs (`...redacted`).
- The NVIDIA API key never appears in this project (it lives in Nightshift's Providers tab).
- The LLM never writes SQL. Agents choose from a fixed catalogue of parameterised queries.
- Validate every input: client slug `^[a-z0-9-]{2,40}$`, dates `^\d{4}-\d{2}-\d{2}$` (start <= end),
  mode in {analyze, full}, question <= 500 chars. Reject anything else with HTTP 400.
- HTTP server: JSON only, request body limit 32 KB, bind 0.0.0.0, no CORS wildcard.
- The agent should use a Zetaris NON-ADMIN user's API key (read-only). The admin key is only used
  by the one-off setup script (env var ZETARIS_ADMIN_API_KEY).
- Treat model output as untrusted: parse strictly as JSON, validate the shape, never eval.
- Publisher is DRY RUN only: writes to outbox/, never calls a social network.
- .gitignore must include: .env, .env.*, !.env.example, node_modules, logs/*.jsonl, .memory/, outbox/.

## Zetaris facts (local install, REST)
- POST {ZETARIS_REST_URL}/sql-editor/sqls/run, default URL http://localhost:8888/api/v1.0
- Headers: Authorization: Bearer <ZETARIS_API_KEY>, X-Org-ID: <ZETARIS_ORG_ID>, X-Request-ID: fresh UUID,
  Content-Type: application/json
- Body: {"queryId": "<uuid>", "sql": "<ONE statement, no trailing semicolon>", "source": "SqlEditor", "limit": 1000}
- Response: {"data": [[...row values as strings...]]} -> map to objects with the known column order, coerce numbers.
- Lightning SQL used for setup:
  CREATE LIGHTNING DATABASE growthloop_files DESCRIBE BY "GrowthLoop CSV files"
  CREATE LIGHTNING FILESTORE TABLE posts FROM growthloop_files FORMAT CSV OPTIONS (
    PATH "/home/zetaris/customer-data/shared/growthloop/posts.csv", header "true", inferSchema "true")
  CREATE NAMESPACE IF NOT EXISTS lightning.metastore.growthloop
  COMPILE USL marketing DEPLOY NAMESPACE lightning.metastore.growthloop DDL
  CREATE TABLE ... (each CREATE TABLE on a new line, scalar types, PRIMARY KEY) — sent as ONE request
  ACTIVATE USL TABLE lightning.metastore.growthloop.marketing.<table> AS SELECT ... (CAST explicitly to the DDL types)
  REGISTER DQ valid_metrics TABLE lightning.metastore.growthloop.marketing.post_performance AS reach > 0 AND engagements <= reach
  RUN DQ valid_metrics TABLE lightning.metastore.growthloop.marketing.post_performance
- CSV files reach Zetaris by copying them into the driver container:
  docker exec zetaris-driver-1 mkdir -p /home/zetaris/customer-data/shared/growthloop
  docker exec -i zetaris-driver-1 sh -c 'cat > /home/zetaris/customer-data/shared/growthloop/posts.csv' < data/posts.csv
- "already exists" errors during setup are OK (setup must be idempotent).

## Meterless Nightshift facts (provider contract)
- OpenAI-compatible. Base URL from env (default http://127.0.0.1:8088/v1), normalise pasted URLs to <host>/v1.
- Headers on every call: Authorization: Bearer <METERLESS_RUNTIME_TOKEN>, meterless-app: growthloop,
  meterless-scope: user. GET /v1/models = discovery (401/403 = "unauthorized", not "offline").
- POST /v1/chat/completions, model from env (default meterless/auto), stream false.
- Send "/no_think" as the first system message; max_tokens ~2000; timeout 120 s;
  retry 429/502/timeout after 2 s, 4 s, 8 s.
- Log the model that ACTUALLY answered: response.meterless.routed_model (fallback: response.model).
- If Nightshift is unavailable or SAMPLE_MODE=true: agents use a deterministic fallback and the trace
  says so (status "fallback"). Never present fallback text as model output.

## Meterless H-MEM
- Vendor the reference implementation UNCHANGED from https://github.com/Meterless/Meterless
  (engines/hmem/reference/src -> vendor/hmem/, plus engines/hmem/conformance -> vendor/hmem-conformance/),
  keep its Apache-2.0 LICENSE and declare it in the README.
- API: new HMEM({ persistDir, actor }); add({content, type, layer, tags, confidence, source, provenance});
  query(text, {topN, threshold}) -> {memories:[{memory, relevance}], context, trace};
  feedback(id, "helpful"|"not_helpful"|"wrong").
- Feature: per-client memory in .memory/<client>/. Recall lessons before analysing; store Critic-approved
  insights after; give feedback when today's data confirms or contradicts a recalled lesson.

## Agents
DataAnalyst (runs catalogue queries on Zetaris, proposes claims citing query/segment/metric/value)
-> EvidenceCritic (checks every cited number against the query results, 3% tolerance; rejects overreach;
   rejected claims go back to DataAnalyst with actual values, max 2 rounds)
-> Strategist (recommendations + 5-post weekly plan, using approved claims + recalled lessons)
-> [mode full] ContentCreator -> BrandReviewer (rules: <=280 chars, WhatsApp CTA, FCFA prices,
   no unprovable superlatives; 1 revision) -> Publisher (dry-run outbox)
-> MemoryKeeper (H-MEM store/feedback).

## Traces
logs/trace-<run_id>.jsonl, one object per line:
{timestamp, run_id, agent_name, action, input_summary, output_summary, target_agent, model,
 retry_count, status} — status in success|needs_revision|rejected|fallback|error|info.
Same events printed as readable lines on stdout.

## Data
Synthetic data for a fictional Douala food business "Saveurs de Douala", clearly labelled as synthetic,
generated by a seeded script: posts.csv, post_metrics.csv, ad_spend.csv, sales.csv.
Existing posts until 2026-09-15, app posts from 2026-09-16 to 2026-10-20.
