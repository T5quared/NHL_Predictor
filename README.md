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

## Player props (NHL + NFL)

**Actions → Daily props (NHL + NFL)** runs at about **1:07 PM Eastern** every day, plus **11:37 AM on Sundays**
(NFL only, before the 1 PM kickoffs). It scans the prop boards, scores every prop, builds `dashboard/props.html`
(NHL and NFL tabs) and posts the top 5 per sport to Discord. NFL picks in Discord are only for games in the next 30 hours.

**One-time setup:** sign up for the free SportsGameOdds Amateur plan (sportsgameodds.com), then add the key as a
repository secret named `SPORTSGAMEODDS_API_KEY`. Without it NHL runs on standard lines (no Edge/Odds) and NFL is
skipped, since NFL lines are player-specific. Usage: one object per game, roughly 300/month NHL + 500/month NFL
out of the free 2,500.

How a prop is scored (settings are in `src/props/config.js`):

1. **Model %**
   - NHL: Poisson on the player's per-game rate (this season shrunk toward last season, plus 30% L10), adjusted
     for tonight's team goal projection or the opponent's shots against.
   - NFL: yardage uses a normal distribution (shrunk average plus 25% L3, and the player's week-to-week spread);
     receptions and anytime TD use Poisson. All are adjusted for what the opponent allows to that position.
2. **Hit rate:** NHL L5/L10/L25/season, NFL L3/L5/L10/season. Small samples are pulled toward the market price.
3. **Final %** = 60% model + 40% hit rate. **Edge** = Final % minus the no-vig consensus price.
4. **Top picks** need the minimum games (NHL 8, NFL 4), a Final % of 55% or more, an edge of +3% or more,
   odds between −250 and +150, and at least 2 books.

Top picks are logged to `data/props-tracker.json` and graded automatically (NHL from game logs the next day,
NFL from nflverse weekly stats). NFL lines move all week, so the last run before kickoff is the one that counts.
The dashboard's "Which half of the blend is predicting better?" box is for the blend review after about 2 weeks.

Stats: NHL API (free, unofficial); NFL from nflverse (free CSVs on GitHub, updated after each game day).

### NHL moneyline
The props run also compares your game model's win % (from the picks run) with the no-vig consensus moneyline,
using the same odds download (no extra credits). Value sides (edge +3%, odds −250 to +200, 2+ books) show on the
**NHL Moneyline** tab, go to Discord under the NHL props, and are logged and graded from final scores.

### Scheduling
GitHub's own scheduler has been running these jobs 3–8 hours late or not at all, so the times that matter are
triggered from cron-job.org through the GitHub API (`workflow_dispatch`). The GitHub crons stay as a backup.
Each sport runs once a day; extra triggers exit in seconds. Tick **Force** on a manual run to run again.

## Changing the model

Edit `MODEL_WEIGHTS` in `src/model.js`, and make the same change in the dashboard HTML in
`dashboard/` — the daily run stops if the two disagree.
