import { Client } from 'pg';

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres@127.0.0.1:5433/postgres'
  });
  await client.connect();
  const res = await client.query('SELECT current_user, session_user, current_database()');
  console.log('Connected! Result:', res.rows);
  await client.end();
}

main().catch(console.error);
