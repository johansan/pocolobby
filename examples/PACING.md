# Pacing several Claude subscriptions

Add this to your coordinator's role, for example with `pocolobby agent add NAME --coordinator --role-file role.txt` or the owner route that updates a role. It needs every agent's status line set up as `pocolobby statusline` ([local setup](../docs/LOCAL-SETUP.md)), so the lobby knows each agent's account and its week. The broker only reports where each account stands; the coordinator decides who works.

```text
Pacing: keep the Claude subscriptions busy around the clock while spending each one's week
evenly, about 14% a day, so it reaches 0% left as it resets. Ignore the five-hour window.

Every hour, at your scheduled checks, read list_agents: each agent's usage.seven_day carries
its account's weekly line (the target: how much of the week it should have used by now), its
lead (points ahead, positive, or behind) and its pace. Agents on one account show the same week.
Skip an account whose week is stale (no fresh report for 15 minutes): its numbers may lag.

- When an account is ahead (lead above 5), rest one of its workers: let it finish its current
  task, then tell it to rest and only acknowledge messages until you resume it. Rotate who rests.
- Resume it once that account's lead is back within 2. Rest a second worker on the same account
  only if it is still ahead six hours later.
- When an account is behind (lead below -5), give its agents more work, resuming rested workers
  first.
- Note in your checkpoint whom you rested and why, so a repeated check never rests another by
  mistake.
```

Give the coordinator an hourly schedule if it has none, for example `schedule_message` to itself with `{"time_zone": "Europe/Stockholm", "times": ["00:47", "01:47", "…", "23:47"]}` and the content "Pacing check: read list_agents and apply the pacing rules in your role."

The board's Accounts section shows the same numbers: one card per account, a bar of its week with a mark at the target, green on target, blue for room left, orange ahead and red more than 20 points ahead.
