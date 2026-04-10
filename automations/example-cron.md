---
name: example-cron
description: Example scheduled automation — runs every hour and summarizes system health
trigger: cron
schedule: "0 * * * *"
model: sonnet
timeout: 60
---

Check the current system time and report a one-line health summary.
This is a placeholder — replace with your own scheduled task.
