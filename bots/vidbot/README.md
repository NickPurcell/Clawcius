# vidbot

Watches the configured Discord channels for Twitter/X links, downloads the
video and posts it back under the crew's bot identity. Receives over the
Discord gateway, falling back to polling. Runs under `bots/supervise.sh`
(see `bots/manifest`); its state, log and `health.json` live in the bot's run
directory, and the state cursor is what stops it re-posting old links.

    python3 vidbot.py -c <channel_id> [-c ...] --interval 6 --state ./state.json --health ./health.json

Tests: `python3 -m unittest discover -s bots/vidbot -p 'test_*.py'` (a scriptable
fake gateway drives the client through fragmentation, zombies and close codes).
