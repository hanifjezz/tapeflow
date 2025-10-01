import mysql from "mysql2/promise";

let pool: mysql.Pool | undefined;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASS!,
      database: process.env.DB_NAME!,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
      connectionLimit: 5,
      waitForConnections: true,
    });
  }
  return pool;
}
