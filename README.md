# The Shrub Lodge — Backend

Express API for The Shrub Lodge, backed by Supabase (PostgreSQL).

## Endpoints

| Method | Route          | Description                          |
| ------ | -------------- | ------------------------------------ |
| GET    | `/`            | API running message                  |
| GET    | `/api/health`  | Health check                         |
| GET    | `/api/rooms`   | All rooms from the Supabase `rooms` table |

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

```env
PORT=5000
FRONTEND_URL=http://localhost:3000
SUPABASE_URL=your-supabase-project-url
SUPABASE_SECRET_KEY=your-supabase-secret-key
```

## Scripts

```bash
npm start        # start the API on http://localhost:5000
npm run dev      # same, with nodemon auto-reload
npm run seed     # (re)load the room catalogue into Supabase
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
