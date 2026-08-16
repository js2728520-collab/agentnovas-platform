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
import migration0023 from "@/drizzle/0023_ai_assistant_strategy_dsl.sql?raw";

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
  ["0023_ai_assistant_strategy_dsl", migration0023],
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

type SchemaTarget =
  | { type: "table" | "index"; name: string }
  | { type: "column"; table: string; name: string };

function schemaTarget(statement: string): SchemaTarget | null {
  const createTable = statement.match(
    /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"[]?([^`"\]\s(]+)/i,
  );
  if (createTable) return { type: "table", name: createTable[1] };

  const createIndex = statement.match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+[`"[]?([^`"\]\s(]+)/i,
  );
  if (createIndex) return { type: "index", name: createIndex[1] };

  const addColumn = statement.match(
    /^ALTER\s+TABLE\s+[`"[]?([^`"\]\s]+)[`"\]]?\s+ADD\s+[`"[]?([^`"\]\s]+)/i,
  );
  if (addColumn) {
    return { type: "column", table: addColumn[1], name: addColumn[2] };
  }

  return null;
}

function normalizedSchemaName(name: string) {
  return name.toLowerCase();
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

  const schema = await database
    .prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'index')")
    .all<{ type: "table" | "index"; name: string }>();
  const schemaObjects = new Set(
    (schema.results ?? []).map(
      (row) => `${row.type}:${normalizedSchemaName(row.name)}`,
    ),
  );
  const columnCache = new Map<string, Set<string>>();
  const migrationRecords = [];

  async function columnsFor(table: string) {
    const normalizedTable = normalizedSchemaName(table);
    const cached = columnCache.get(normalizedTable);
    if (cached) return cached;

    const escapedTable = table.replaceAll('"', '""');
    const columns = await database
      .prepare(`PRAGMA table_info("${escapedTable}")`)
      .all<{ name: string }>();
    const names = new Set(
      (columns.results ?? []).map((row) => normalizedSchemaName(row.name)),
    );
    columnCache.set(normalizedTable, names);
    return names;
  }

  for (const [name, sql] of migrations) {
    if (completed.has(name)) continue;

    for (const statement of statements(sql)) {
      const target = schemaTarget(statement);
      if (target?.type === "table" || target?.type === "index") {
        const key = `${target.type}:${normalizedSchemaName(target.name)}`;
        if (schemaObjects.has(key)) continue;
      } else if (target?.type === "column") {
        const columns = await columnsFor(target.table);
        if (columns.has(normalizedSchemaName(target.name))) continue;
      }

      try {
        await database.prepare(statement).run();
      } catch (error) {
        // Older production databases can already contain the schema while the
        // migration ledger is empty. Only tolerate SQLite's explicit
        // "already applied" errors; all other failures must remain visible.
        if (!isAlreadyAppliedSchemaError(error)) throw error;
      }

      if (target?.type === "table" || target?.type === "index") {
        schemaObjects.add(
          `${target.type}:${normalizedSchemaName(target.name)}`,
        );
      } else if (target?.type === "column") {
        const columns = await columnsFor(target.table);
        columns.add(normalizedSchemaName(target.name));
      }
    }

    migrationRecords.push(
      database
        .prepare("INSERT OR IGNORE INTO _agentnovas_migrations (name) VALUES (?)")
        .bind(name),
    );
    completed.add(name);
  }

  if (migrationRecords.length > 0) await database.batch(migrationRecords);
}
