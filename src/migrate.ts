import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL } from 'bun';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL (veja .env.example)');

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const dir = join(import.meta.dir, '..', 'migrations');
const db = new SQL(url);

await db`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const files = readdirSync(dir)
  .filter((f) => f.endsWith(`.${direction}.sql`))
  .sort();
const applied = new Set(
  (await db`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name),
);

if (direction === 'up') {
  for (const file of files) {
    const name = file.replace('.up.sql', '');
    if (applied.has(name)) continue;
    await db.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.log(`aplicada: ${name}`);
  }
} else {
  // down: desfaz só a ÚLTIMA migration aplicada
  const last = [...applied].sort().at(-1);
  if (!last) {
    console.log('nada para desfazer');
  } else {
    await db.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, `${last}.down.sql`), 'utf8'));
      await tx`DELETE FROM schema_migrations WHERE name = ${last}`;
    });
    console.log(`desfeita: ${last}`);
  }
}
await db.close();