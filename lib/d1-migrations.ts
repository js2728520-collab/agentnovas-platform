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
] as const;

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureD1Schema() {
  const database = env.DB;
  if (!database) throw new Error("D1 数据库 DB 尚未绑定");

  await database.exec(
    "CREATE TABLE IF NOT EXISTS _agentnovas_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );

  const applied = await database
    .prepare("SELECT name FROM _agentnovas_migrations")
    .all<{ name: string }>();
  const completed = new Set((applied.results ?? []).map((row) => row.name));

  for (const [name, sql] of migrations) {
    if (completed.has(name)) continue;
    const queries = statements(sql).map((statement) => database.prepare(statement));
    queries.push(
      database
        .prepare("INSERT INTO _agentnovas_migrations (name) VALUES (?)")
        .bind(name),
    );
    await database.batch(queries);
  }
}
