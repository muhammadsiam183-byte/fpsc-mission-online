# FPSC Mission 16+ — Shared date-based online version

## What changed in this version
- Visitors choose a study date in the website. The date can be today, a past date, or a future date.
- The first visitor who requests a date and content type (MCQs or interview practice) triggers one generation. The result is stored in a shared Supabase database.
- Every later visitor requesting that same date and content type receives the saved result. Cached requests do not use generation slots or call OpenAI.
- A database function enforces a maximum of **two new generation attempts per UTC calendar day across all visitors and all dates**. The limit is global, not per IP, browser, or country. Failed provider attempts also consume a slot to prevent unlimited retries/costs.
- If another visitor is currently generating a date, requests wait briefly for the saved result and then ask the user to retry if generation is still running.
- MCQs and interview practice are cached separately for each date. Therefore they each count as a new set if not already saved, but either can be opened repeatedly once saved.
- Previously saved sets remain available even after the daily generation limit is reached.
- The backend checks saved sets for existing question IDs to reduce repeats across dates.
- MCQ mode remains strict: it requests only question wording verifiable against official FPSC-published material and does not pad a set with invented “past-paper” questions. Fewer than 30 MCQs may be returned.
- Interview prompts and model answers are original preparation material, not claimed to be verbatim official FPSC interview questions.

## Important date and limit rules
- The shared generation quota resets at **00:00 UTC**, not at midnight in each visitor's local timezone. This prevents users in different countries from each receiving a separate quota.
- The first request for a date/type determines the priority area and target count used for that saved set. All visitors receive that same saved result, even if they choose a different priority area afterward. To keep the shared set stable, the app does not regenerate or overwrite an existing date/type.
- A selected date is a label for the set. If someone generates a set for a past date today, it uses sources available when generated today; it is not a historical snapshot of the internet on that past date.
- The two-slot quota counts attempts, not only successful responses. A failed generation can use one slot.

## Setup and deployment (browser-only)

### 1. Upload the updated project to GitHub
1. Download the updated ZIP and extract it.
2. Upload the *contents* of `fpsc-mission-online` to your GitHub repository root, replacing the previous `index.html`, `api/daily.js`, `package.json`, `vercel.json`, and `README.md`.
3. Also upload the new `supabase-schema.sql` file.
4. Commit the changes. Vercel should start a deployment automatically if the repository is already connected.

### 2. Create a shared Supabase database
1. Go to https://supabase.com/ and create a project.
2. In the project dashboard, open **SQL Editor** and create a new query.
3. Open `supabase-schema.sql` from this project, copy all its SQL, paste it into the editor, and run it once.
4. In Supabase **Project Settings → API** (or **Connect**, depending on the dashboard version), copy the Project URL and a server-side secret/service-role key.
5. Keep the secret/service-role key private. Never put it in `index.html` or any client-side JavaScript.

### 3. Add environment variables in Vercel
In Vercel, open your project → **Settings → Environment Variables**. Add these variables for **Production**:

- `OPENAI_API_KEY` = your OpenAI API key
- `SUPABASE_URL` = your Supabase Project URL, for example `https://YOUR_PROJECT.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase server-side service-role/secret key
- Optional `OPENAI_MODEL` = `gpt-4.1-mini` (or another model enabled for Responses API web search and structured outputs)

Save the variables, then go to **Deployments** and redeploy the latest deployment. Open your `.vercel.app` URL.

### 4. Test the shared behavior
1. Open the live website and note the selected date.
2. If that date/type has not been saved, the first request may generate a set and use one of the two daily slots.
3. Open the same website in a private/incognito window or another device and request the same date/type. It should load the saved shared set without generating another one.
4. Choose another unsaved date. It can use the second slot that UTC day. A third unsaved date/type should be blocked until the quota resets, but saved dates still work.
5. Check Vercel Function Logs if the site reports a Supabase or API configuration error.

## Security and cost
- Do not expose `OPENAI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in the front end, screenshots, public GitHub files, or chat messages.
- The Supabase service-role key bypasses row-level security and must only be used in the server-side Vercel function.
- OpenAI API usage can cost money separately from a ChatGPT subscription. Set a budget/spending alert in your API account.
- The daily limit is enforced by a PostgreSQL function, not by a browser counter. That means simultaneous users share the same limit.

## Official source links
- FPSC GR syllabi: https://fpsc.gov.pk/Syllabuses?section=GR+Syllabus
- FPSC homepage: https://fpsc.gov.pk/
- FPSC Information Desk: https://www.fpsc.gov.pk/InformationDesk
- Pakistan Code: https://pakistancode.gov.pk/

## Troubleshooting
- **Shared cache is not configured**: add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel and redeploy.
- **Database error / RPC not found**: ensure you ran the complete `supabase-schema.sql` in the correct Supabase project.
- **Daily limit reached**: two new generation attempts have already been reserved for the current UTC date. Saved sets still load; wait until the UTC date resets for another new set.
- **Another visitor is generating**: wait a few seconds and load that date again.
- **Insufficient verified questions**: official FPSC material did not expose enough verifiable MCQs. The service intentionally does not invent official past-paper questions.
- **Opened from Downloads**: the API requires deployment; open the hosted Vercel URL.
