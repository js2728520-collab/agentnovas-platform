import { env } from "cloudflare:workers";

import migration0000 from "@/drizzle/0000_small_dreadnoughts.sql?raw";
import migration0001 from "@/drizzle/0001_red_loki.sql?raw";
import migration0002 from "@/drizzle/0002_lean_skreet.sql?raw";
import migration0003 from "@/drizzle/0003_strange_robbie_robertson.sql?raw";
import migration0004 from "@/drizzle/0004_square_starhawk.sql?raw";
import migration0005 from "@/drizzle/0005_glossy_komodo.sql?raw";
import migration0006 from "@/drizzle/0006_careless_bullseye.sql?raw";
import migration0007 from "@/drizzle/0007_lazy_tattoo.sql?raw";
import migration0008 from "@/drizzle/0008_certain_nova.sql?raw";
import migration0009 from "@/drizzle/0009_solid_senator_kelly.sql?raw";
import migration0010 from "@/drizzle/0010_clumsy_runaways.sql?raw";
import migration0011 from "@/drizzle/0011_fuzzy_leper_queen.sql?raw";
import migration0012 from "@/drizzle/0012_medical_wrecker.sql?raw";
import migration0013 from "@/drizzle/0013_fat_molly_hayes.sql?raw";
import migration0014 from "@/drizzle/0014_natural_mandroid.sql?raw";
import migration0015 from "@/drizzle/0015_pink_logan.sql?raw";
import migration0016 from "@/drizzle/0016_tiresome_jack_murdock.sql?raw";
import migration0017 from "@/drizzle/0017_phone_registration.sql?raw";
import migration0018 from "@/drizzle/0018_unique_user_names.sql?raw";
import migration0019 from "@/drizzle/0019_strategy_publication_mode.sql?raw";
import migration0020 from "@/drizzle/0020_platform_follow_policy.sql?raw";
import migration0021 from "@/drizzle/0021_platform_ai_strategies.sql?raw";
import migration0022 from "@/drizzle/0022_market_watchlist.sql?raw";

const migrations = [
  ["0000_small_dreadnoughts", migration0000],
  ["0001_red_loki", migration0001],
  ["0002_lean_skreet", migration0002],
  ["0003_strange_robbie_robertson", migration0003],
  ["0004_square_starhawk", migration0004],
  ["0005_glossy_komodo", migration0005],
  ["0006_careless_bullseye", migration0006],
  ["0007_lazy_tattoo", migration0007],
  ["0008_certain_nova", migration0008],
  ["0009_solid_senator_kelly", migration0009],
  ["0010_clumsy_runaways", migration0010],
  ["0011_fuzzy_leper_queen", migration0011],
  ["0012_medical_wrecker", migration0012],
  ["0013_fat_molly_hayes", migration0013],
  ["0014_natural_mandroid", migration0014],
  ["0015_pink_logan", migration0015],
  ["0016_tiresome_jack_murdock", migration0016],
  ["0017_phone_registration", migration0017],
  ["0018_unique_user_names", migration0018],
  ["0019_strategy_publication_mode", migration0019],
  ["0020_platform_follow_policy", migration0020],
  ["0021_platform_ai_strategies", migration0021],
  ["0022_market_watchlist", migration0022],
] as const;

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function isAlreadyAppliedSchemaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("already exists") ||
    normalized.includes("duplicate column name")
  );
}

export async function ensureD1Schema() {
  const database = env.DB;
  if (!database) throw new Error("D1 数据库 DB 尚未绑定");

  await database
    .prepare(
      "CREATE TABLE IF NOT EXISTS _agentnovas_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();

  const applied = await database
    .prepare("SELECT name FROM _agentnovas_migrations")
    .all<{ name: string }>();
  const completed = new Set((applied.results ?? []).map((row) => row.name));

  for (const [name, sql] of migrations) {
    if (completed.has(name)) continue;

    for (const statement of statements(sql)) {
      try {
        await database.prepare(statement).run();
      } catch (error) {
        // Older production databases can already contain the schema while the
        // migration ledger is empty. Only tolerate SQLite's explicit
        // "already applied" errors; all other failures must remain visible.
        if (!isAlreadyAppliedSchemaError(error)) throw error;
      }
    }

    await database
      .prepare("INSERT OR IGNORE INTO _agentnovas_migrations (name) VALUES (?)")
      .bind(name)
      .run();
    completed.add(name);
  }
}
