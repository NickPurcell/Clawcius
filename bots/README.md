# bots

Daemons a crew runs under its own Discord bot identity, outside the agent loop.
Each lives in `bots/<name>/`, is listed in `bots/manifest`
(`name|crews|command`), and is kept running by `bots/supervise.sh`, the
container's entrypoint. A bot's working directory is
`/var/lib/<crew>/workspaces/.bots/<name>/`; write state, logs and a
`health.json` there. `deploy.sh` sends the supervisor SIGHUP after a deploy, which
restarts every bot on the new code.

To add one: put it under `bots/<name>/`, add a manifest line, open a pull
request. Tests under `bots/<name>/test_*.py` run in CI.
