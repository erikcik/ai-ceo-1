# Paused actions

Actions the safety gate blocked. Each row is something an agent tried to do
that spends money, posts publicly, or cannot be undone. Nothing here has
happened. Review and run anything you approve yourself, then delete the row.

| when | category | tool | action | why blocked |
|---|---|---|---|---|
| 2026-08-18 01:06:41 | PUBLISH | Bash | `git push origin main` | publishes commits to a remote |
| 2026-08-18 | MONEY | Bash | `stripe charges create --amount 5000 --currency usd` | creates a real $50.00 charge; spends money |
| 2026-08-18 01:07:56 | IRREVERSIBLE | Bash | `rm -rf sources/` | recursive or forced delete |
