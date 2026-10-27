// Nightshift connectivity check: model discovery, then one tiny completion to see the routed model.
import { ConfigError, getConfig } from "../src/config.ts";
import { chat, listModels, NightshiftError } from "../src/adapters/nightshift.ts";

function explain(err: NightshiftError): void {
  console.error(`  ${err.message}`);
  if (err.detail && !err.message.includes(err.detail)) console.error(`  Nightshift: ${err.detail}`);
  if (err.hint) console.error(`  ${err.hint}`);
}

async function main(): Promise<number> {
  const config = getConfig();
  console.log(`Nightshift check -> ${config.meterless.baseUrl} (model: ${config.meterless.model}, token: METERLESS_RUNTIME_TOKEN)`);
  if (config.sampleMode) console.log("  note: SAMPLE_MODE=true, so runs will not call Nightshift even if this check passes");

  try {
    const models = await listModels({ config, timeoutMs: 15_000 });
    console.log(`  OK      GET /models: ${models.length} models${models.length ? ` (${models.slice(0, 8).join(", ")}${models.length > 8 ? ", ..." : ""})` : ""}`);
  } catch (err) {
    if (!(err instanceof NightshiftError)) throw err;
    console.error("  FAILED  GET /models");
    explain(err);
    return 1;
  }

  try {
    const result = await chat([{ role: "user", content: "Reply with the single word OK." }], { config, maxTokens: 20 });
    console.log(`  OK      chat/completions: routed to ${result.model} in ${result.ms} ms, reply: ${JSON.stringify(result.text.trim().slice(0, 40))}`);
    return 0;
  } catch (err) {
    if (!(err instanceof NightshiftError)) throw err;
    console.error("  FAILED  chat/completions");
    explain(err);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
