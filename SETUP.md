# Setting up cloud sync

The journal works fine with no setup at all — it just saves to that one browser's storage, same as before. Follow these steps if you want your trades to follow you across devices and browsers instead.

## 1. Create a free Supabase project
1. Go to https://supabase.com and sign up (GitHub login is fastest)
2. Click **New project**, give it any name, set a database password (save it somewhere), pick the region closest to you
3. Wait ~2 minutes for it to spin up

## 2. Create the table
1. In your project, open **SQL Editor** (left sidebar)
2. Click **New query**
3. Paste in everything from `schema.sql` (included in this project) and click **Run**

This creates one table, `journal_data`, with security rules so each account can only ever see its own row.

## 3. Connect the app to your project
1. In Supabase, go to **Project Settings → API**
2. Copy the **Project URL** and the **anon public** key
3. Open `config.js` in this project and paste them in:
   ```js
   const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
   ```
4. Save, then push to GitHub / redeploy on Vercel (or just reopen `index.html` locally)

## 4. Turn off email confirmation (optional, for personal use)
By default Supabase requires clicking a confirmation link before you can log in. For a single-user personal tool that's an extra step you don't need:
1. **Authentication → Providers → Email**
2. Turn off **Confirm email**

If you leave it on, just check your inbox after signing up and click the link once.

## That's it
Once `config.js` has real values, the app shows a login screen. Sign up once with any email/password, and from then on that same login pulls your trades on any device or browser. If it can't reach Supabase (offline, wrong keys, etc.) it keeps working off the local copy and shows "Sync failed — saved locally" so you know.
