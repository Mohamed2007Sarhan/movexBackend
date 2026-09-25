import ep from 'embedded-postgres';
import path from 'path';
import fs from 'fs';

const EmbeddedPostgres = (ep as any).default || ep;

const dbDir = path.resolve(process.cwd(), 'data/postgres');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const pgInstance = new EmbeddedPostgres({
  port: 5433,
  persistent: true,
  databaseDir: dbDir,
  user: 'postgres'
});

export async function ensureDbRunning() {
  try {
    await pgInstance.initialise();
  } catch (e: any) {
    // If already initialised, continue
  }
  try {
    await pgInstance.start();
    console.log('[DB] Embedded PostgreSQL started on port 5433');
  } catch (e: any) {
    if (e.message?.includes('already running') || e.message?.includes('lock')) {
      console.log('[DB] Embedded PostgreSQL is already running');
    } else {
      console.warn('[DB] Warning starting PostgreSQL:', e.message);
    }
  }
}

export async function stopDb() {
  try {
    await pgInstance.stop();
    console.log('[DB] Embedded PostgreSQL stopped');
  } catch (e: any) {
    console.warn('[DB] Warning stopping PostgreSQL:', e.message);
  }
}

if (process.argv[2] === 'start') {
  ensureDbRunning().then(() => {
    console.log('PostgreSQL running. Press Ctrl+C to exit.');
  });
} else if (process.argv[2] === 'stop') {
  stopDb();
}
