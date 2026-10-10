# Making the leaderboard stick — step by step

Without this, the scores and accounts live in a file inside the server, and a
file inside the server disappears every time the site redeploys. This moves
them to Supabase, which keeps them.

It is three things: run one piece of SQL, copy two values, paste them into
Render. Fifteen minutes, once, and never again.

---

## Step 1 — Create the table in Supabase

1. Go to **supabase.com** and open your project.
2. In the left menu, find **SQL Editor** (it has a `>_` icon).
3. Press **New query**.
4. Open `supabase/migrations/0002_accounts.sql` from this repository, copy
   **all** of it, and paste it into the big empty box.
5. Press **Run** (bottom right, or Ctrl/Cmd + Enter).

You want to see **Success. No rows returned.** That is what success looks
like for this kind of SQL — it made a table, so it has no rows to show you.

> If it complains that something already exists, that is fine. The script is
> written to be safe to run twice.

**Check it worked:** left menu → **Table Editor** → you should now see a table
called `domino_accounts`. It will be empty. Good.

---

## Step 2 — Copy the two values

Still in Supabase: left menu → **Project Settings** (the gear) → **API**.

You need two things from that page:

| What to find | What it looks like |
| --- | --- |
| **Project URL** | `https://something.supabase.co` |
| The key labelled **`service_role`** | a very long string, marked **secret** |

There are two keys on that page. `anon` / `public` is the wrong one. You want
**`service_role`**. You may have to press a *Reveal* or eye button to see it.

> **This key is the keys to the building.** It ignores every security rule in
> your project. Do not put it in a message, a screenshot, or a file in the
> repository. It goes in one place only: Render's settings, in the next step.
> If you ever think it has leaked, the same page has a button to roll it.

---

## Step 3 — Paste them into Render

In Render, open your **domino** service → **Environment** → **Add variable**.
That is the first box on that page. *Not* Secret Files.

Add these, one at a time:

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | the Project URL from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from step 2 |
| `ADMIN_PASSWORD` | a password of your own — see below |

**Save.** Render redeploys on its own, which takes a few minutes.

### About `ADMIN_PASSWORD`

The accounts table is empty, so the admin account is about to be created from
scratch in it. `ADMIN_PASSWORD` is what it will be created with. Set it to
something only you know and the placeholder `qwerty` is never used at all.

Pick something you will remember. There is no email on these accounts, so
there is no "forgot password" link — if you lose the admin password your way
back in is to change `ADMIN_PASSWORD` here and redeploy.

---

## Step 4 — Check it took

Render → your service → **Logs**. After the deploy finishes, look for:

```
[domino] 1 account(s) loaded from Supabase
```

**"from Supabase" is the bit that matters.** If instead you see:

```
[domino] accounts are in a local file — a host that rebuilds its container will lose them
```

then one of the three is wrong. Work down this list:

| What the log says | What it means |
| --- | --- |
| `...in a local file` | The two variables are missing, misspelled, or were not saved. Check for a stray space. |
| `accounts are OFF: ... could not be read` | The variables arrived but the table is not there. Step 1 did not run, or ran against a different project. |
| `...loaded from Supabase` | Done. |

Then open the site and sign in as `Xay` with your `ADMIN_PASSWORD`.

**The real test:** redeploy once more (Render → Manual Deploy), and sign in
again. If your account is still there, it is working — that is exactly the
thing that used to be lost.

---

## If you have a computer handy

From the repository, with the same two values set:

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run verify:supabase
```

It checks the table exists, and — more importantly — tries to read a password
hash the way an outsider would, and fails loudly if it succeeds.
