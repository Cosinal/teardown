const { sql, init, POLICY_VERSION } = require('../lib/db');
const crypto = require('crypto');
const isAdmin = k => { const a = process.env.ADMIN_KEY || ''; return !!a && typeof k === 'string' && k.length === a.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(a)); };
module.exports = async (req, res) => {
  await init();
  if (req.method === 'GET') {
    if (!isAdmin(req.query.key)) return res.status(401).json({ error: 'unauthorized' });
    const rows = await sql`SELECT email, created_at, consent, policy_version FROM signups ORDER BY created_at`;
    return res.json({ count: rows.length, signups: rows });
  }
  if (req.method === 'DELETE') {
    if (!isAdmin(req.query.key)) return res.status(401).json({ error: 'unauthorized' });
    const email = String(req.query.email || '').trim().toLowerCase();
    const r = await sql`DELETE FROM signups WHERE email = ${email} RETURNING id`;
    return res.json({ deleted: r.length });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (b.consent !== true) return res.status(400).json({ error: 'Please agree to the Privacy Policy to join.' });
  const r = await sql`INSERT INTO signups (email, consent, policy_version) VALUES (${email}, true, ${POLICY_VERSION}) ON CONFLICT (email) DO NOTHING RETURNING id`;
  if (!r.length) return res.status(409).json({ error: 'This email is already on the waitlist.' });
  res.json({ ok: true });
};
