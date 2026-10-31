# Setting up the watcher (issue #10)

The watcher messages a rider on Telegram when their window opens and whenever their commute answer changes. It is
live on production; the one-message test passed on 2026-10-31 at 04:26 PHT (1 run). These steps are what the owner
did to set it up, and repeat it for a new bot. Every value below is a placeholder; real values go only into Vercel
and the scheduler, never into this repo.

Why Telegram and an outside scheduler: see the comment on issue #10 (Messenger's 24-hour window, and Vercel Hobby
cron running once a day). Correction to the Messenger half: Meta's Utility Messages are meant for sending outside that
window, and a utility template for the Lusong Page was approved on creation (2026-10-31). Reaching people outside the
app's own roles still needs Meta's App Review, so Telegram stays the channel for now.

As set up on 2026-10-31: the bot is `@lusong_cebu_bot`; the four values are on Vercel **Production**, not Preview,
because previews sit behind Vercel Authentication and answer 401 to outside calls; the webhook points at
`https://lusong-mocha.vercel.app/api/watch/telegram`; the scheduler is `.github/workflows/watch-tick.yml` (§5).

## 1. Create the bot (BotFather)

1. In Telegram, open a chat with `@BotFather` and send `/newbot`.
2. Give it a display name (for example "Lusong") and a username ending in `bot` (for example `lusong_cebu_bot`).
3. BotFather replies with the bot's token. Treat it like a password: anyone who has it can send messages as the bot.

## 2. Make two secrets

Telegram allows only `A-Z`, `a-z`, `0-9`, `_` and `-` in a webhook secret, 1 to 256 characters
(core.telegram.org/bots/api, setWebhook `secret_token`). This makes one that fits, so run it twice, once per secret:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 3. Add four env vars to Vercel Preview

Run each command and paste the value when it asks. Nothing goes on the command line, so nothing lands in shell history.

```sh
vercel -Q ~/.config/vercel-personal env add TELEGRAM_BOT_TOKEN preview      # BotFather's token
vercel -Q ~/.config/vercel-personal env add TELEGRAM_BOT_USERNAME preview   # the username, without the @
vercel -Q ~/.config/vercel-personal env add TELEGRAM_WEBHOOK_SECRET preview # secret 1
vercel -Q ~/.config/vercel-personal env add WATCH_TICK_SECRET preview       # secret 2
```

The watcher uses the same Upstash database as the budget (`UPSTASH_REDIS_REST_URL` / `_TOKEN`, or `KV_REST_API_*`),
so it needs no new store. While any of the four is unset, the switch on the page says "The watcher isn't set up yet."
An unset `TELEGRAM_WEBHOOK_SECRET` or `WATCH_TICK_SECRET` makes its route refuse every call.

Redeploy the preview so it picks them up, and note its URL. Below, `<preview-host>` is that host name, with no
`https://` in front.

UNVERIFIED: a preview behind Vercel's Deployment Protection may refuse Telegram's and QStash's calls. If step 4's
`getWebhookInfo` shows a 401 or 403 error, or the tick in step 5 never runs, add a protection bypass for automation in
the Vercel project settings, or test on a deployment that isn't protected.

## 4. Point the bot's webhook at Lusong

Run this in your own terminal. It sends the token to Telegram, and only to Telegram. The leading space keeps the line
out of zsh history if `HIST_IGNORE_SPACE` is set.

```sh
 read -rs "BOT?Bot token: "; echo; read -rs "HOOK?Webhook secret: "; echo
 curl -s "https://api.telegram.org/bot$BOT/setWebhook" \
   --data-urlencode "url=https://<preview-host>/api/watch/telegram" \
   --data-urlencode "secret_token=$HOOK" \
   --data-urlencode 'allowed_updates=["message"]'
 curl -s "https://api.telegram.org/bot$BOT/getWebhookInfo"
 unset BOT HOOK
```

`setWebhook` should answer `{"ok":true,...}`. `getWebhookInfo` should show the URL, and no `last_error_message` once
a message has been sent to the bot.

## 5. The scheduler: GitHub Actions, every 10 minutes

In use: GitHub Actions, `.github/workflows/watch-tick.yml`, every 10 minutes at minutes 3, 13, … 53, with `WATCH_TICK_SECRET` as a repository
secret (`gh secret set WATCH_TICK_SECRET`, value from stdin). GitHub can start a scheduled run late or skip one under
load (GitHub's docs on the `schedule` event), so a rider's message can arrive later than the 10 minutes. "Run workflow"
on the Actions tab runs a tick by hand.

**Open, 2026-10-31 09:43 PHT:** GitHub had started 0 scheduled runs, 5 h 22 min after the schedule merged, though the
workflow is `active`. Moving the cron off the round minutes and disabling then re-enabling the workflow changed nothing.
Until a scheduled run appears, a tick happens only by hand. QStash, below, is the way round it.

The alternative: an Upstash QStash schedule. It can fire every minute or less often ("The maximum schedule resolution
is 1 minute", QStash's create-a-schedule API page), but the Upstash account behind this project was made through
Vercel's integration, so its console needs a sign-in through Vercel first.

In the Upstash console, open QStash, then Schedules, then create one:

- Destination: `https://<preview-host>/api/watch/tick`
- Method: `POST`
- Cron: `*/10 * * * *` (QStash reads cron in UTC by default; the watcher reads its windows in PHT whatever the
  scheduler's zone is, so UTC is fine)
- Header: `Upstash-Forward-Authorization: Bearer <WATCH_TICK_SECRET>`, so QStash sends `Authorization: Bearer …` to
  Lusong. QStash forwards any `Upstash-Forward-*` header (QStash's publishing docs).
  UNVERIFIED: that it forwards `Authorization` this way; the docs' example uses a custom header name. If step 6's
  tick log shows 401s, check this first.
- Retries: 0. A missed tick is followed by another one 10 minutes later anyway.

Each tick checks up to 20 watchers that are in their window and haven't been checked in the last 9 minutes, and it
finishes in under 45 s, inside the route's 60 s limit.

## 6. One-message test

1. On a phone, open the preview, pick "Your own trip", and tap home then work in Metro Cebu.
2. In "Watcher on Telegram", set a window that includes the next 10 minutes (PHT) and tap "Switch the watcher on".
3. Tap "Link Telegram". Telegram opens the bot. Tap Start. The bot answers "Linked. Lusong will message you here
   between … PHT …". That reply is the first real message. Go back to the page and it shows "On: Lusong messages you
   on Telegram …".
4. Wait for the next tick, or run it now from your own terminal:

   ```sh
    read -rs "TICK?Tick secret: "; echo
    curl -s -X POST -H "Authorization: Bearer $TICK" https://<preview-host>/api/watch/tick; echo; unset TICK
   ```

   It answers with a count, for example `{"ok":true,"due":1,"checked":1,"sent":1,"failed":0,"deferred":0}`, and the
   phone gets "Lusong is watching your trip until … PHT. At …: Go" (or whatever the answer is).
5. Tap "Switch the watcher off". That deletes the trip, the chat link and the history from the store. The bot sends
   nothing more.

`"sent":0` with `"failed":1` means the check gave no answer (the daily cap, the routing server, the report store) or
Telegram didn't take the message or didn't answer. The Vercel function log for `/api/watch/tick` says which. A message
Telegram refused is sent again at the next check; one it didn't answer for (a timeout, a 5XX) counts as sent and isn't,
so a rider is never messaged twice about the same answer, at the cost of a message that may be missed.
