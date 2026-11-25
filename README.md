# Doctor Sync Webhook

Listens for Monday.com webhooks when doctor info columns change on pipeline boards,
then syncs the changed field to the MM Doctor Database.

## Flow
1. User edits doctor info on any pipeline board (Profile Send Off, Medical Evaluation, Insurance, Welcome Call)
2. Monday webhook fires to this service
3. Service looks up every Doctor Database entry with that NPI (a doctor has one entry per office)
4. Keeps the entries whose name matches. Credentials and suffixes (MD, PA-C, FNP-BC, Jr), a leading Dr.,
   "Last, First", a middle name or initial, and a space inside a surname don't count as a difference.
   None match → logs `[NAME MISMATCH]`, does NOT update
5. Several entries left → picks the office this patient is seen at by their clinic address, then clinic
   name, fax, phone (never the column being edited). Still can't tell → logs `[AMBIGUOUS]`, does NOT update
6. Updates the changed column on that one entry

## Environment Variables
- `MONDAY_API_TOKEN` — Monday.com API token (required)
- `PORT` — Server port (auto-set by Railway)
- `FRIDAY_FORWARD`, `FRIDAY_URL`, `FRIDAY_API_KEY`, `FRIDAY_BOARD_IDS` — the Friday forward (below); off unless `FRIDAY_FORWARD=1`
- `NTFY_URL`, `NTFY_TOPIC` — optional: where the forward pushes an alert when it gives up on a write
- `FRIDAY_SHADOW` — the Friday read shadow (below); off unless `1`. Uses `FRIDAY_URL` / `FRIDAY_API_KEY` (or `FRIDAY_SHADOW_URL` / `FRIDAY_SHADOW_KEY`)

## The Friday forward
Friday (Medically Modern's own board app, `medically-modern/friday`) keeps a copy of the MM Doctor Database
(18142847597) and is handed every write this service makes there. `src/fridayForward.js` is the same CommonJS
module josh-monday-automations and auto-doctor-database-search carry: `mondayQuery` hands it each mutation Monday
accepted (no `errors`, data in the answer), after Monday's answer, and it posts the write exactly as sent to Friday's
`POST /v1/monday/write` from an in-memory queue drained in order. It never throws and never delays Monday's answer;
a restart loses what was queued (Friday's hourly check and sync from Monday are the net). Only a write naming a board
in `FRIDAY_BOARD_IDS` is sent (`18142847597`). `GET /` shows it under `friday`. Keep `mondayQuery` the only Monday
call: `test/fridayForward.test.js` fails on another.

## The Friday read shadow (2026-11-25)
Every read Monday answers through `mondayQuery` is handed with Monday's answer to Friday's `POST /v2/shadow`
(`src/fridayShadow.js`, the same module every reader of Monday carries; reader `doctor-sync-webhook`), which runs the
same read on Friday and keeps how the two answers compare (counts and paths, never a value). After the answer, never
awaited, never retried, never a mutation or a read Monday refused. Off unless `FRIDAY_SHADOW=1`. `GET /` shows it
under `friday_shadow`; `test/fridayShadowWiring.test.js` pins the wiring.

## Deploy to Railway
1. Connect this repo to Railway
2. Set root directory to `services/doctor-sync-webhook`
3. Set the `MONDAY_API_TOKEN` environment variable
4. Deploy — Railway will auto-detect Node.js

## Webhook Registration
After deploying, webhooks must be registered via the Monday API pointing to:
`https://<your-railway-url>/webhook`
