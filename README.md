# NHL Predictor

Runs the v8.2 prediction model every day on GitHub, sets the injury toggle automatically,
posts the picks to Discord and saves picks and results in this repo. Nothing needs to be
running on your PC.

## One-time setup

1. In this repo: **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `DISCORD_WEBHOOK_URL`
3. Value: your Discord webhook URL (the one in `discord-webhook.txt` next to `proxy.js`)

Until that secret exists, runs fail on purpose and nothing is posted or saved.

## Daily run

- Runs at about **11:07 AM Eastern** (10:07 AM in winter). GitHub can start it up to ~30 minutes late.
- To change the time, edit the `cron` line in `.github/workflows/daily-picks.yml` (it is in UTC).
- To run it by hand: **Actions → Daily NHL picks → Run workflow**. Tick *Dry run* to see the
  output without posting, or *Force* to resend today's picks.

Each run:

1. Fills in final scores for earlier picks.
2. Predicts today's games with the v8.2 model (v8.1 maths + smarter injury toggle).
3. Posts to Discord, in the same format as the dashboard's Send to Discord button, plus a line
   naming the players behind each 🏥 and a results line.
4. Saves to `data/tracker.json` (same fields as the dashboard tracker) and `data/last-run.json`
   (every input behind today's numbers).

## Automatic injury toggle

A team's toggle is on when a player listed as out is one of its top 6 forwards or top 4
defensemen by ice time, or its starting goalie. Rules are in `INJURY_RULES` at the top of
`src/injuries.js`.

- Injury list: ESPN's public NHL injuries feed (unofficial).
- Counts as out: Out, Injured Reserve, Suspension. Day-To-Day does not count.
- Ice time: this season blended with last season, so someone out since camp is still ranked.
- If the feed is down, no toggles are applied and the Discord post says so.

Picks saved by this script carry `auto: true` and `injuryMode: "auto"` so they can be kept
separate from picks made with manual toggles.

## Differences from the dashboard

- **Back-to-back now applies.** The dashboard looks for yesterday's game in the NHL "this week"
  schedule, which starts today, so it never finds one and the penalty never fires. This script
  checks yesterday's results directly.
- Injury toggles are automatic instead of manual.
- Everything else is the same maths. `node --test` compares this script against
  `dashboard/nhl-dashboard-v8.1.html` on 2,000 random games and runs before every daily run.

## Changing the model

Edit `MODEL_WEIGHTS` in `src/model.js`, and make the same change in the dashboard HTML in
`dashboard/` — the daily run stops if the two disagree.
