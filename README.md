# The Shrub Lodge — Backend

Express API for The Shrub Lodge, backed by Supabase (PostgreSQL).

## Endpoints

| Method | Route                       | Description |
| ------ | --------------------------- | ----------- |
| GET    | `/`                         | API running message |
| GET    | `/api/health`               | Health check |
| GET    | `/api/rooms`                | Rooms from Supabase |
| GET    | `/api/public/content`       | Public editable site content and safe site settings |
| GET    | `/api/public/works`         | Published works |
| GET    | `/api/public/works/:slug`   | One published work |
| GET    | `/api/public/posts`         | Published and due scheduled updates |
| GET    | `/api/public/posts/:slug`   | One published or due scheduled update |
| POST   | `/api/public/contact`       | Store a contact enquiry (Next.js proxy only) |
| POST   | `/api/admin/auth/login`     | Admin login (server-side frontend proxy only) |
| GET    | `/api/admin/auth/session`   | Validate the current admin session |
| POST   | `/api/admin/auth/logout`    | Revoke the current admin session |
| PATCH  | `/api/admin/auth/password`  | Change the administrator password |

The authenticated admin API also provides:

- `GET /api/admin/overview`, `/works`, `/content`, `/posts`, `/media`,
  `/messages`, `/settings`, and `/activity`
- `POST /api/admin/works`, `/posts`, and `/media`
- `PUT /api/admin/works/:id`, `/posts/:id`, `/content/:key`, and `/settings`
- `PATCH /api/admin/works/order`, `/media/:id`, and `/messages/:id`
- `DELETE /api/admin/works/:id`, `/posts/:id`, and `/media/:id`

Admin requests require the server-only `x-admin-proxy-secret` header. Authenticated
requests also require a bearer session token; state-changing requests require
the matching `x-csrf-token`. The login response contains credentials for the
frontend server proxy and must never be returned to browser JavaScript. The
proxy will set the browser session cookie as `httpOnly`, `Secure`, and
`SameSite=Strict`.

Sessions expire after 30 minutes of inactivity and have a 12-hour absolute
maximum. Five failed password checks lock the account for 15 minutes. Login is
also rate-limited per backend process.

## Setup

```bash
npm install
```

In PowerShell, copy `.env.example` to `.env` and fill in the server credentials:

```bash
Copy-Item .env.example .env
```

```env
PORT=5000
FRONTEND_URL=http://localhost:3000
SUPABASE_URL=your-supabase-project-url
SUPABASE_SECRET_KEY=your-supabase-secret-key
ADMIN_API_PROXY_SECRET=a-long-random-secret
CONTACT_API_PROXY_SECRET=a-different-long-random-secret
RESEND_API_KEY=your-resend-api-key
ADMIN_RESET_FROM_EMAIL="The Shrub Lodge <passwords@your-verified-domain.com>"
```

Generate the proxy secret locally, then use the same value in the backend and
the Next.js server environment (never a `NEXT_PUBLIC_` variable):

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Apply `database/cms-schema.sql` in the Supabase SQL Editor before using the admin
authentication. It creates private admin/session/reset-token tables, editable site content,
works, posts, media metadata, contact messages, and the activity log. It also
creates the public-read-only `site-media` storage bucket for website images.
The SQL also adds a transaction-safe function that only allows the first owner
account to be created once.
Only the backend service key has table write access; do not expose it to the
frontend.

Open `/lodge-owner-console/login` on the frontend and create the first account.
Passwords of any non-zero length are supported and are hashed before storage.
Use a long, randomly generated password for security. Signup is available only
while no admin exists and closes automatically after the first account is created.
Because there is no setup key, create your account before exposing the site
publicly; another visitor could otherwise claim the first account.

### Admin password reset email

Set `RESEND_API_KEY` and `ADMIN_RESET_FROM_EMAIL` in the backend environment.
The sender address must be verified with Resend. The reset email contains a
single-use link that expires after 30 minutes. Re-run
`database/cms-schema.sql` in Supabase to create the password-reset table and
atomic token-consumption function before enabling this flow.

Alternatively, create the first account with the command line. Temporarily set
`ADMIN_EMAIL` and `ADMIN_PASSWORD` in the backend `.env`, then run:

```powershell
npm run create-admin
```

Remove `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` after the account is
created. The command stores only a bcrypt password hash and refuses to replace
an existing account. Keep `ADMIN_API_PROXY_SECRET` configured.
Set a separate random value for `CONTACT_API_PROXY_SECRET` in the backend and
Next.js server environment. It protects the server-to-server contact submission
route; never expose it to browser code.

## Scripts

```bash
npm start        # start the API on http://localhost:5000
npm run dev      # same, with nodemon auto-reload
npm run seed     # (re)load the room catalogue into Supabase
npm run create-admin # create the first dashboard administrator
```

## `rooms` table schema

| Column            | Type                     |
| ----------------- | ------------------------ |
| `id`              | integer (primary key)    |
| `name`            | text                     |
| `description`     | text                     |
| `room_type`       | text                     |
| `price_per_night` | numeric                  |
| `capacity`        | integer (default 2)      |
| `image_url`       | text                     |
| `created_at`      | timestamptz (default now)|

## Deployment (Render)

`render.yaml` describes the service (Node 20, free plan, health check at
`/api/health`). Create a Blueprint from the repo and set the secret env vars:

```env
SUPABASE_URL=your-supabase-project-url
SUPABASE_SECRET_KEY=your-supabase-secret-key
ADMIN_API_PROXY_SECRET=a-long-random-secret
CONTACT_API_PROXY_SECRET=a-different-long-random-secret
RESEND_API_KEY=your-resend-api-key
ADMIN_RESET_FROM_EMAIL="The Shrub Lodge <passwords@your-verified-domain.com>"
FRONTEND_URL=https://the-shrub-lodge.vercel.app
```

`FRONTEND_URL` accepts a comma-separated list, so production and Vercel preview
URLs can be allowed at once (for example
`http://localhost:3000,https://the-shrub-lodge.vercel.app`). Run `npm run seed`
once to load the rooms table.

### Troubleshooting: "Missing environment variable"

If the deploy logs show:

```
Error: Missing environment variable: SUPABASE_URL
```

the process started without that variable. The `.env` file is git-ignored, so it
does **not** exist on Render. Set the variables in the Render dashboard:

**Service → Environment → Environment Variables**

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `ADMIN_API_PROXY_SECRET`
- `CONTACT_API_PROXY_SECRET`
- `RESEND_API_KEY`
- `ADMIN_RESET_FROM_EMAIL`
- `FRONTEND_URL`

Then redeploy. Note that `sync: false` values in `render.yaml` are intentionally
not stored in git and are only applied when the service is created from the
Blueprint; for a manually created Web Service, add them by hand.

Another sign the Blueprint isn't applied: the logs show Node 24 even though
`render.yaml` sets `NODE_VERSION=20`.

## Quick test

Once running, these should respond in a browser:

- http://localhost:5000/ — API running message
- http://localhost:5000/api/health — successful health check
- http://localhost:5000/api/rooms — JSON response containing the rooms

The Next.js dashboard uses a same-origin server proxy; do not call the admin
login endpoint directly from a browser. Public Works and Updates display only
published content (scheduled posts appear after their scheduled time). The
Next.js contact form persists submissions using the separate contact proxy
secret. See `../Frontend/README.md` for the full setup and owner login steps.

If a CMS table is not present yet, public content, works, and posts endpoints
return safe empty/default responses and log a single warning per missing table
instead of generating repeated request errors. Apply `database/cms-schema.sql`
to enable dashboard changes and persistent CMS features; the fallback does not
store dashboard edits.
