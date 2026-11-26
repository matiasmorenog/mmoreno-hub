# mmoreno-hub

Personal hub for Matias Adrian Moreno Gallo. Tools live as sections of the same app: a **daily job-search brief**, a **medication / supplement checklist**, and a tracker of applications already in motion. A shopping list and other tools may follow.

The daily brief stays one section of the hub. It is not a separate product.

Live app: <https://mmoreno-brief.vercel.app>

This repository is the source. Pushing it does not change that deployment. Brief rows, tracker rows, and credentials live in Neon and in the host's environment, not in git.

## Stack

- Static UI: vanilla JavaScript, HTML, and CSS in `site/`
- API: Vercel Functions in `site/api` (`brief`, `toggle`, `item`, `tracker`, `login`, `meds`, `med-dose`, `shopping`)
- Database: Neon Postgres through `@neondatabase/serverless`
- Runtime: Node.js 22

`site/vercel.json` is the project config (region `gru1`, function memory and duration, cache and security headers). Point the Vercel project root at `site/`.

## Data model

`schema.sql` creates the tables below. Apply it once to an empty database (or re-run for additive `IF NOT EXISTS` / seed `ON CONFLICT DO NOTHING`). Do not commit a connection string.

| Table | Role |
| --- | --- |
| `brief_meta` | Single row (`id = 1`) for the current brief: date, headline, run note, agenda, open processes, out-of-search note, discarded roles, sources, and `actualizado_en`. |
| `items` | Cards and checklist rows. `seccion` is one of `atencion`, `listos`, `ofertas`, `resuelto`. Optional links, score, extra JSON, priority, start date, due date, done flag, and archive flag. |
| `item_log` | History of checkbox changes (`item_id`, `done`, `origen`, timestamp). |
| `applications` | Job-search tracker: section, date, company, role, status, score, source, link, notes, and sort order. |
| `seen` | Dedup keys (`clave`, type, company key, date, detail). |
| `rutina_estado` | Named timestamps for routines. |
| `medications` | Catalog of meds/supplements: `nombre`, optional `notas`, optional `momento` (`manana` / `mediodia` / `noche`), `activo`, `orden`. |
| `medication_doses` | Per-day taken flag (`medication_id`, `fecha`, `tomado`, `tomado_en`). Primary key is idempotent for one dose row per med per calendar day. |
| `shopping_items` | Shopping list rows: `nombre`, optional `cantidad` / `notas`, `comprado`, `comprado_en`, `orden`. |

Indexes: `items.done_at`, `applications.empresa_key`, `applications.fecha`, `medications(activo, orden)`, `medication_doses.fecha`.

“Today” for doses uses `America/Argentina/Buenos_Aires` (same TZ as the brief).

## Environment variables

The API reads only these names. Set them in the shell, in a gitignored `.env`, or in the Vercel project. `.env.example` lists the names and nothing else. Never commit real values.

| Name | Used for |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string passed to `@neondatabase/serverless`. |
| `SESSION_SECRET` | HMAC key for the `mb_s` session cookie (90 days, HttpOnly, Secure, SameSite=Strict). |
| `BRIEF_PASSWORD` | Password checked by `POST /api/login` when the optional gate is on. |
| `APP_PASSWORD_GATE` | Set to `on` to require that password. Any other value leaves the gate off. |

The live site can also sit behind Vercel Authentication. That is a project setting, not an env var this code reads.

## Run locally

Requirements: Node.js 22, a Neon database with `schema.sql` applied, and the four variables above.

```bash
npm install
cp .env.example .env
```

Fill in `.env` on your machine. `vercel dev` loads env files from the directory that contains `vercel.json`, so export the variables or copy the gitignored `.env` to `site/.env` as well.

```bash
cd site
npx vercel dev
```

Open the local URL. The **Brief** tab loads `GET /api/brief`. Under **Necesita tu atención**, the form posts to `POST /api/item` (creates an `items` row with `seccion = 'atencion'`). Checking an item posts a batch to `POST /api/toggle`. The **Medicación** tab loads `GET /api/meds` (catalog + today’s doses); checkboxes post to `POST /api/med-dose`; catalog create/update/delete use `POST` / `PATCH` / `DELETE /api/meds` (hard delete; dose rows cascade). The **Compras** tab loads `GET /api/shopping`; add/check/delete/clear-bought use `POST` / `PATCH` / `DELETE` / `POST` on `/api/shopping`. The **Tracker** tab loads `GET /api/tracker` on demand.

Apply the schema yourself against the database you own, for example:

```bash
psql "$DATABASE_URL" -f schema.sql
```

## Deploy

Production is already at <https://mmoreno-brief.vercel.app>. Do not retarget or redeploy that project unless you mean to change the live app.

For a new or preview deployment:

1. Create or link a Vercel project with root directory `site/`.
2. Set `DATABASE_URL`, `SESSION_SECRET`, `BRIEF_PASSWORD`, and `APP_PASSWORD_GATE` in that project's environment.
3. From `site/`, run `npx vercel` for a preview deployment.

`npx vercel --prod` updates the linked production deployment. Skip that command when the link is the existing live app and you do not intend to ship.

## What is not in this repo

No passwords, connection strings, Vercel or Neon project ids, or job-application rows. Local secret files (`.env*`, `.database_url`, `.password`, `.session_secret`, `.seed.json`, `.applications.json`, and similar) are gitignored. `.env.example` is the only env file that belongs in git.
