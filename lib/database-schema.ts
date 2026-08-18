export async function ensureDatabaseSchema() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL 尚未配置；请先运行 PostgreSQL 迁移再启动服务");
  }
}
