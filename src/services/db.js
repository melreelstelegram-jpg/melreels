import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "A variável de ambiente DATABASE_URL não foi definida.",
  );
}

// Bancos gerenciados (Railway, Supabase, etc.) exigem SSL; localhost normalmente não usa.
const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

export default pool;
