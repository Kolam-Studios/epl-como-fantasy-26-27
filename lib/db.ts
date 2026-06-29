import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var _sql: ReturnType<typeof postgres> | undefined;
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Reuse one pool across hot reloads / serverless invocations.
export const sql = global._sql ?? postgres(url, { max: 5 });
if (process.env.NODE_ENV !== "production") global._sql = sql;
