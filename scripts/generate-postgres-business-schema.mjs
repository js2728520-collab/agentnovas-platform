import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const sourceDirectory = new URL("../drizzle/", import.meta.url);
const database = new DatabaseSync(":memory:");

for (const file of readdirSync(sourceDirectory).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
  const migration = readFileSync(new URL(file, sourceDirectory), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
}

function identifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function postgresType(sqliteType) {
  const normalized = String(sqliteType || "text").toLowerCase();
  if (normalized.includes("int")) return "integer";
  if (normalized.includes("real") || normalized.includes("float") || normalized.includes("double")) return "double precision";
  if (normalized.includes("blob")) return "bytea";
  return "text";
}

function postgresDefault(value, type) {
  if (value == null) return "";
  const normalized = String(value).trim();
  if (/^current_timestamp$/i.test(normalized) && type === "text") {
    return " DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
  }
  if (/^false$/i.test(normalized) && type === "integer") return " DEFAULT 0";
  if (/^true$/i.test(normalized) && type === "integer") return " DEFAULT 1";
  if (/^(?:-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/.test(normalized)) return ` DEFAULT ${normalized}`;
  throw new Error(`Unsupported default ${normalized}`);
}

function constraintName(table, columns, id) {
  const base = `fk_${table}_${columns.join("_")}_${id}`.replace(/[^A-Za-z0-9_]/g, "_");
  return base.slice(0, 60);
}

const tables = database.prepare(`
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all().map(row => row.name);

const lines = [
  "-- Generated from the legacy SQLite schema by scripts/generate-postgres-business-schema.mjs.",
  "-- Keep legacy booleans as integers and timestamps as ISO text so the existing Drizzle schema remains wire-compatible.",
  "",
  `CREATE TABLE IF NOT EXISTS "_agentnovas_migrations" (`,
  `  "name" text PRIMARY KEY,`,
  `  "applied_at" text NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  ");",
  "",
];

for (const table of tables) {
  const columns = database.prepare(`PRAGMA table_info(${identifier(table)})`).all();
  const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
  lines.push(`CREATE TABLE IF NOT EXISTS ${identifier(table)} (`);
  const definitions = columns.map(column => {
    const type = postgresType(column.type);
    const inlinePrimary = primary.length === 1 && column.pk === 1 ? " PRIMARY KEY" : "";
    return `  ${identifier(column.name)} ${type}${inlinePrimary}${column.notnull ? " NOT NULL" : ""}${postgresDefault(column.dflt_value, type)}`;
  });
  if (primary.length > 1) definitions.push(`  PRIMARY KEY (${primary.map(column => identifier(column.name)).join(", ")})`);
  lines.push(definitions.join(",\n"), ");", "");
}

for (const table of tables) {
  const indexes = database.prepare(`PRAGMA index_list(${identifier(table)})`).all()
    .filter(index => index.origin === "c")
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const index of indexes) {
    const source = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name)?.sql;
    const normalized = String(source || "").replaceAll("`", '"');
    const prefix = `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${identifier(index.name)} ON ${identifier(table)}`;
    if (!normalized.startsWith(prefix)) throw new Error(`Unsupported index ${index.name}`);
    lines.push(`${prefix.replace("INDEX ", "INDEX IF NOT EXISTS ")}${normalized.slice(prefix.length)};`);
  }
}
lines.push("");

for (const table of tables) {
  const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${identifier(table)})`).all();
  const grouped = Map.groupBy(foreignKeys, foreignKey => foreignKey.id);
  for (const [id, rows] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.seq - b.seq);
    const name = constraintName(table, rows.map(row => row.from), id);
    const target = rows[0].table;
    const onUpdate = String(rows[0].on_update || "NO ACTION").toUpperCase();
    const onDelete = String(rows[0].on_delete || "NO ACTION").toUpperCase();
    lines.push(
      "DO $$ BEGIN",
      `  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${literal(table)}::regclass AND conname = ${literal(name)}) THEN`,
      `    ALTER TABLE ${identifier(table)} ADD CONSTRAINT ${identifier(name)} FOREIGN KEY (${rows.map(row => identifier(row.from)).join(", ")}) REFERENCES ${identifier(target)} (${rows.map(row => identifier(row.to)).join(", ")}) ON UPDATE ${onUpdate} ON DELETE ${onDelete} DEFERRABLE INITIALLY DEFERRED;`,
      "  END IF;",
      "END $$;",
    );
  }
}

database.close();
process.stdout.write(`${lines.join("\n")}\n`);
