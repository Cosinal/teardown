# Teardown

One-page market readouts for new business ideas. This repo is the Next.js (App Router, TypeScript) app: the waitlist site plus the scaffold for the teardown engine.

## Local setup

Requirements: Node 20+ and a Neon Postgres database (the production one from Vercel's Neon integration, or a separate dev branch).

```bash
npm install
cp .env.example .env.local   # then fill in DATABASE_URL and ADMIN_KEY
npm run dev                  # http://localhost:3000
```

To pull the env vars from the linked Vercel project instead, run `vercel env pull .env.local`.

The `signups` table is created on first request if it doesn't exist, and the nullable `ref` column is added to existing tables (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Existing rows are never modified or dropped.

Checks:

```bash
npm run typecheck
npm run build
```

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string. |
| `ADMIN_KEY` | Secret for the admin endpoints below. Admin access is disabled if unset. |

Never commit `.env*` files. Only `.env.example` is tracked.

## Routes

| Route | Description |
| --- | --- |
| `/` | Waitlist landing page. `?ref=<code>` is stored with the signup. |
| `/privacy`, `/data` | Privacy Policy and Data Policy. |
| `GET /api/count` | `{ "count": n }`: the total number of signups and nothing else. Polled every 4s by the home page. |
| `POST /api/subscribe` | `{ email, consent: true, ref? }`. Returns 400 for an invalid email or missing consent, 409 for a duplicate. |
| `GET /api/subscribe?key=ADMIN_KEY` | Admin: list all signups. |
| `DELETE /api/subscribe?key=ADMIN_KEY&email=...` | Admin: delete one signup. |
| `POST /api/teardown` | `{ idea }`. Returns a stub `TeardownReport` (engine not implemented yet). |

Admin examples:

```bash
curl "http://localhost:3000/api/subscribe?key=$ADMIN_KEY"
curl -X DELETE "http://localhost:3000/api/subscribe?key=$ADMIN_KEY&email=someone@example.com"
```

## Layout

- `app/`: pages and API route handlers
- `components/Join.tsx`: waitlist form and live counter (client component)
- `styles/home.css`, `styles/legal.css`: page styles ported verbatim from the static site. Fonts are self-hosted in `public/fonts/`.
- `lib/db.ts`: Neon client and schema setup
- `lib/engine/`: teardown engine (`runTeardown`, `TeardownReport`), currently a stub
