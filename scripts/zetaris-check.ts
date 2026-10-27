// Connectivity check with the agent's own (non-admin) key: SELECT 1, then row counts per USL table.
import { ConfigError, getConfig } from "../src/config.ts";
import { runSql, toObjects, ZetarisError } from "../src/adapters/zetaris.ts";

const USL_TABLES = ["post_performance", "campaign_daily", "orders"] as const;

function explain(err: ZetarisError): void {
  console.error(`  ${err.message}`);
  if (err.detail && !err.message.includes(err.detail)) console.error(`  Zetaris: ${err.detail}`);
  if (err.hint) console.error(`  ${err.hint}`);
}

async function main(): Promise<number> {
  const config = getConfig();
  console.log(`Zetaris check -> ${config.zetaris.restUrl} (key: ZETARIS_API_KEY)`);

  try {
    await runSql("SELECT 1");
    console.log("  OK      SELECT 1 (reachable, key accepted)");
  } catch (err) {
    if (!(err instanceof ZetarisError)) throw err;
    console.error("  FAILED  SELECT 1");
    explain(err);
    return 1;
  }

  let failed = 0;
  for (const table of USL_TABLES) {
    const fq = `${config.zetaris.usl}.${table}`;
    try {
      const { rows } = await runSql(`SELECT COUNT(*) AS n FROM ${fq}`);
      const [row] = toObjects(rows.slice(0, 1), ["n"]);
      console.log(`  OK      ${fq}: ${String(row?.n)} rows`);
    } catch (err) {
      if (!(err instanceof ZetarisError)) throw err;
      failed++;
      console.error(`  FAILED  ${fq}`);
      explain(err);
    }
  }
  if (failed > 0) console.error("\nSome USL tables are missing or unreadable. Run: npm run zetaris:setup");
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
