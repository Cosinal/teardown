const { sql, init } = require('../lib/db');
module.exports = async (req, res) => {
  await init();
  const [r] = await sql`SELECT count(*)::int AS n FROM signups`;
  res.setHeader('Cache-Control', 'no-store'); res.json({ count: r.n });
};
