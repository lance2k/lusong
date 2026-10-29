# Setting up the watcher (issue #10)

The watcher messages a rider on Telegram when their window opens and whenever their commute answer changes. The code
is built and tested with a fake channel. Nothing has ever been sent to Telegram from it. These steps are for the
owner, who has to create the bot. Every value below is a placeholder; real values go only into Vercel and the
scheduler, never into this repo.

Why Telegram and an outside scheduler: see the comment on issue #10 (Messenger's 24-hour window, and Vercel Hobby
cron running once a day).

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

## 5. The scheduler: QStash, every 10 minutes

Recommended: an Upstash QStash schedule. It runs on the Upstash account that already holds the database, and it can
fire every minute or less often ("The maximum schedule resolution is 1 minute", QStash's create-a-schedule API page).
GitHub Actions' `schedule` and cron-job.org are the other choices, and either can send the same header.

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
Telegram didn't take the message. The Vercel function log for `/api/watch/tick` says which.
