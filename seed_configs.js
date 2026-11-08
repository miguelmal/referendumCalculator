const { Client } = require('pg');

const templates = [
  {
    name: 'Board Referendum',
    config: { voteOptions: ['APROBADA', 'NO APROBADA', 'ABSTENIDO'], contentField: 'Resumen' }
  },
  {
    name: 'Presentacion de Casos',
    config: { voteOptions: ['A Favor', 'No a Favor', 'Abstenido'], contentField: 'Asunto' }
  }
];

async function seed(dbName) {
  const client = new Client({ connectionString: `postgresql://localhost:5432/${dbName}` });
  await client.connect();
  for (const t of templates) {
    const query = `
      INSERT INTO template_configs (template_name, config)
      VALUES ($1, $2)
      ON CONFLICT (template_name) DO UPDATE SET config = EXCLUDED.config
    `;
    await client.query(query, [t.name, t.config]);
  }
  console.log(`Seeded templates into ${dbName}`);
  await client.end();
}

async function run() {
  await seed('docusign_vote_counter_dev');
  await seed('docusign_vote_counter_prod');
}
run().catch(console.error);
