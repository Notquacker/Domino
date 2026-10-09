# Supabase setup

The game runs fine without any of this — Supabase adds accounts and stats, and
every part of it degrades to the guest behaviour when the environment variables
below are unset.

## 1. Apply the schema

In the Supabase dashboard, open **SQL Editor** and run
`migrations/0001_init.sql`. Or, with the Supabase CLI linked to your project:

```bash
supabase db push
```

## 2. Turn on anonymous sign-in

**Authentication → Providers → Anonymous sign-ins → enable.**

This is what lets a player type a name and play immediately while still getting
a real, durable identity. They can attach an email later and keep their record.

## 3. Set the environment variables

Server (never expose the service role key to a browser):

| Variable | Where to find it |
| --- | --- |
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` secret |

Client (safe to ship in the bundle — RLS is what protects the data):

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | same Project URL |
| `VITE_SUPABASE_ANON_KEY` | Project Settings → API → `anon` public key |

## How the pieces fit

```
browser ──anonymous sign-in──▶ Supabase Auth ──JWT──▶ browser
browser ──JWT──▶ game server ──verifies against JWKS──▶ trusted user id
game server ──service role──▶ record_match()  (the only write path)
browser ──anon key + RLS──▶ profiles / matches / player_stats  (read only)
```

Clients have **no** write access to the match tables: there is no insert policy
on them, and `record_match()` is revoked from `anon` and `authenticated`. A
tampered client cannot award itself a win.
