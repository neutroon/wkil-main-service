const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_bFpPOo9fU4lj@ep-sparkling-frog-adtfpf6e.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require' });
  await client.connect();
  const res = await client.query(`
    SELECT pid, query FROM pg_stat_activity WHERE pid IN (
        SELECT pid FROM pg_locks WHERE locktype = 'advisory'
    );
  `);
  console.log("Locks found:", res.rows);
  
  // Terminate those PIDs
  for (const row of res.rows) {
      if (row.pid !== client.processID) {
          console.log('Terminating PID:', row.pid);
          await client.query(`SELECT pg_terminate_backend(${row.pid})`);
      }
  }
  
  await client.query(`SELECT pg_advisory_unlock_all()`);
  console.log('Done clearing locks.');
  await client.end();
}
main().catch(console.error);
