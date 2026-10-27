# GrowthLoop

## What it does

GrowthLoop is a multi-agent "marketing team in a product" for small businesses in Cameroon.
It runs a closed loop over a business's own data:

1. **Audit** the content, ads and sales the business already has (the first run for a new client
   is always an audit of its existing posts; posts carry `origin` = `existing` | `app`).
2. **Critique** every finding against the query results before anyone acts on it.
3. **Plan**: recommendations and a 5-post plan for next week, built only on verified findings.
4. **Create** a draft post for each plan slot.
5. **Brand review** each draft against hard brand rules, with one revision.
6. **Dry-run outbox**: approved drafts are queued in a local JSON file; nothing is published.
7. **Learn**: verified insights are stored in memory so the next run starts from them.

The demo client is "Saveurs de Douala", a fictional food business with synthetic data (see
[Synthetic data](#synthetic-data)).

**Status.** In the repository today: the agents (`src/agents/`), the fixed query catalogue with
its Zetaris and sample-mode implementations (`src/analytics/`), the Zetaris REST adapter and setup
scripts, run traces, the synthetic data generator and the web UI (`frontend/`). Still being added:
the run orchestrator and HTTP server (`run.ts`), the Meterless Nightshift model adapter, and
H-MEM memory (step 7).

## Architecture

```
Browser: React UI (frontend/, built to frontend/dist)
   |  POST /run {client, mode: analyze|full, question, period}
   v
run.ts serve: HTTP server + run orchestrator                            [being added]
   |
   |-- MemoryKeeper: recall lessons for this client (H-MEM)              [being added]
   v
DataAnalyst ---- fixed query catalogue (src/analytics/queries.ts)
   |               |-- Zetaris REST -> USL tables post_performance, campaign_daily, orders
   |               '-- SAMPLE_MODE  -> the same queries computed on data/*.csv
   | claims citing query / segment / metric / value
   v
EvidenceCritic --- deterministic number checks, then optional model overreach review
   |   rejected: back to DataAnalyst with the actual values
   v approved claims
Strategist ------- summary, recommendations, 5-post plan
   |
   v mode "full" only
ContentCreator -> BrandReviewer -> Publisher (dry run: outbox/<run_id>.json)
   |
   v
MemoryKeeper: store approved insights, feedback on recalled lessons     [being added]

Model calls:  every agent receives an injected Llm function (Meterless Nightshift adapter
              being added). No model available -> deterministic fallback, traced as "fallback".
Traces:       every step -> logs/trace-<run_id>.jsonl + one readable line on stdout.
```

The agents never write SQL and never call `fetch`. They choose from a catalogue of 10
parameterised queries, each with two equivalent implementations that return identical columns:
`sql()` for the Zetaris USL tables and `compute()` for the in-memory sample tables.

| Query | Returns |
|---|---|
| `format_performance`, `pillar_performance`, `language_performance`, `platform_performance` | per segment: posts, avg engagement rate, avg reach, avg clicks |
| `timing_performance` | the same by time of day: morning (< 12:00), midday_afternoon (12:00-17:59), evening (>= 18:00) |
| `cta_performance` | the same for posts with / without a call to action |
| `origin_comparison` | the same for existing posts vs posts planned with GrowthLoop |
| `promo_roi` | per promo code: ad spend, orders, revenue, ROAS, cost per order |
| `top_posts` | top 5 posts by engagement rate |
| `data_quality` | total, valid and invalid posts under the rule `reach > 0 AND engagements <= reach` |

Segment queries only use valid rows (the same rule as the Zetaris data-quality check `valid_metrics`).

## Agents

Agents receive their model (`Llm`) and memory (`MemoryPort`) as parameters (`src/agents/ports.ts`),
so each one works, and is tested, with or without a model.

| Agent | Role | Without a model |
|---|---|---|
| **DataAnalyst** (`analyst.ts`) | Runs the catalogue (a failed query is logged and skipped). Proposes claims that cite exact query / segment / metric / value; the first evidence item is the winning segment. Revises claims the critic rejected. | Best-vs-worst claim per segment query (segments with at least 3 posts) plus a promo ROI claim. Rejected claims are repaired by recomputing their numbers from the actual values, or dropped. |
| **EvidenceCritic** (`critic.ts`) | Checks every cited value against the query results (3% relative tolerance). Every decimal, percentage or FCFA amount in the statement must match an evidence value or a ratio of two. Rejects segments with fewer than 3 posts, causal wording, and sales conclusions not backed by `promo_roi`. Then an optional model review for overreach, which can only reject, never approve. | Deterministic checks only. |
| **Strategist** (`strategist.ts`) | Summary, recommendations (each must cite approved claim ids; unknown ids are dropped) and a 5-post plan with allow-listed values. Promo codes must already exist. | Rule-based recommendations and plan from the winning segments of the approved claims. |
| **ContentCreator** (`content.ts`, mode `full`) | One draft per plan slot. Platform, format, language and hour always come from the plan, never from the model. | Templates per language (French, English, Pidgin) and content pillar. |
| **BrandReviewer** (`content.ts`) | Hard rules: at most 280 characters (caption + hashtags), a WhatsApp call to action, a price in FCFA, no other currency, no phone number, no unprovable superlatives ("best in Douala", "number 1", "meilleur de Douala", "garanti"...). Then an optional model tone review that can only reject. Rejected drafts get one revision. | Rules only; a rejected draft is replaced by its rule-safe template. |
| **Publisher** (`content.ts`) | Dry run: writes approved drafts to `outbox/<run_id>.json` with status `queued_dry_run`, and lists blocked drafts with their issues. Makes no network call. | Same (no model involved). |
| **MemoryKeeper** | Recalls lessons before the analysis; stores approved insights afterwards; gives feedback when today's data confirms or contradicts a recalled lesson. | [being added with H-MEM] |

Every critique, rejection and revision is a trace event (`status`: `success`, `needs_revision`,
`rejected`, `fallback`, `error` or `info`), with the agent it is sent to (`target_agent`) and the
model that actually answered (`model`, null for deterministic steps).

## Data layer: Zetaris

## AI provider: Meterless Nightshift

TODO

## Memory engine: Meterless H-MEM

TODO

## Quick start

TODO

## Configuration

## Sample mode

## Running tests

TODO

## Traces

## Security

- **Secrets** come only from environment variables (`.env`, gitignored; `.env.example` has
  placeholders). `src/config.ts` is the only module that reads `process.env`. Key and token values
  containing whitespace or control characters are rejected, so they cannot inject HTTP headers.
- **Redaction**: trace events and Zetaris error details pass through `redact()`, which replaces
  known secret values, `Bearer` tokens and fields named like token / api key / secret / password /
  authorization with `...redacted`.
- **No model-written SQL**: queries come from a fixed catalogue. Only validated values reach a
  statement: real calendar dates in `YYYY-MM-DD` with start <= end, and a dotted-identifier USL
  namespace. The Zetaris adapter sends exactly one statement per request.
- **Model output is untrusted**: it is parsed with `JSON.parse` only (never `eval`) and every field
  is validated: query ids must be in the catalogue, plan values come from allow-lists, promo codes
  must exist, recommendations must cite approved claims. A model cannot approve a claim that fails
  the number checks, or a draft that breaks a brand rule.
- **File names**: run ids are restricted to `[A-Za-z0-9_-]` before being used in trace and outbox
  file names (no path traversal).
- **Publishing is a dry run**: the Publisher writes a local JSON file and never calls a social network.
- **Docker**: the image runs as the unprivileged `node` user. `.env` is excluded from the build
  context by `.dockerignore`, so secrets are never baked into the image; they are passed at runtime.

## Synthetic data

All data in `data/` is **synthetic**. "Saveurs de Douala" is a fictional food business in Douala;
no row is real customer, sales or social-media data. Details: [data/README.md](data/README.md).

- Produced by a seeded, deterministic generator (`npm run data:generate`, seed 237): the same seed
  gives byte-identical CSVs.
- `posts.csv` (95 posts), `post_metrics.csv`, `ad_spend.csv` (173 rows), `sales.csv` (2,039 orders),
  from 2026-07-01 to 2026-10-20. Amounts are in FCFA.
- Posts up to 2026-09-15 are `origin = existing` (the audit set); later posts are `origin = app`.
- Patterns are planted on purpose (format, time of day, language, pillar, promo code returns) so the
  agents have something true to find. They are effects of the generator, not findings about any
  real business.
- Exactly 3 rows are deliberately invalid, to exercise the data-quality rule.

## Known limitations

- **Publishing is dry-run only.** Approved posts are written to `outbox/<run_id>.json`; nothing is
  posted anywhere.
- **No live Meta (Facebook / Instagram) or TikTok API yet.** Post metrics, ads and sales come from
  the CSV data loaded into Zetaris, not from the networks.
- **Synthetic data.** Results describe the generator's planted patterns, not a real business.
- **The agent uses an admin Zetaris API key on this local install.** The intended setup gives the
  agents a read-only non-admin key and keeps the admin key for the one-off setup script.
- The critic verifies decimals, percentages and FCFA amounts in claim statements; plain integers
  (post counts, hours) are not checked.
- Findings are associations, not causes. Promo ROI attributes orders to a campaign by promo code only.
- The brand profile (menu, prices, promo codes) for the demo client is hard-coded in
  `src/agents/content.ts`.

## Third-party code and licenses

npm dependencies (installed by npm, not vendored):

| Package | Used by | License |
|---|---|---|
| tsx | backend (runs TypeScript) | MIT |
| typescript | backend and frontend (type checking) | Apache-2.0 |
| @types/node | backend (types) | MIT |
| react, react-dom | frontend | MIT |
| vite, @vitejs/plugin-react | frontend (dev server and build) | MIT |
| @types/react, @types/react-dom | frontend (types) | MIT |

Vendored code: TODO (Meterless H-MEM reference implementation, Apache-2.0, to be added under `vendor/`).
