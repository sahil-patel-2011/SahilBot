---
name: everyday-scheduling-reminders
description: Set reminders, recurring tasks and calendar events, plan the week with time blocks, and handle time zones correctly.
source: you
uses: 0
category: Everyday
triggers: remind me, set a reminder, reminder for, add to my calendar, calendar event, recurring reminder, every week remind, plan my week, time blocking, to do list, find a time to meet, daily routine, deadline reminder, schedule a reminder
---

## Pick the right tool
- schedule: reminders and recurring tasks that SahilBot itself runs later in this bot's chat (e.g. "every Monday at 8am summarize my week").
- mac_apps: Apple Reminders (lists, due dates) and Calendar events on the Mac, synced to iPhone.
- Google Calendar / Todoist connectors via find_tools when the user lives there. Check memory for their preferred tool.

## Get the details right
What, when (date, time, time zone), how often (once, daily, weekdays, monthly on the 1st), how far ahead to alert, which list or calendar, and location or link. Resolve relative dates ("next Friday") against today's date explicitly and state the absolute date back ("Friday, Nov 21 at 9:00 am ET"). For travel or remote meetings, show both time zones.

## Invitations
Creating an event only on the user's own calendar is fine when asked. Sending invites to other people is sending a message: draft it and get the user's yes first.

## Weekly planning
1. Brain dump tasks and commitments; pull calendar events for the week.
2. Pick top 3 priorities; estimate time for each.
3. Time-block: deep work in the user's best hours, admin batches, buffers (~25%), breaks, personal time.
4. Put blocks on the calendar if they want; set reminders for deadlines a few days early.
5. Friday 15-minute review: done, moved, learned.

## Habits and routines
Attach new habits to existing ones, start tiny, daily reminders at a consistent time, track streaks in a simple sheet.

## Verify
After creating anything, list it back (title, date/time with zone, recurrence, alert) by reading it from the tool, so the user can catch mistakes. Don't create duplicates; check existing reminders first.

## Pitfalls
Wrong AM/PM or time zone, recurring events without an end date when one was intended, too many notifications (alarm fatigue), reminders with no actionable wording ("Call dentist to book cleaning: 555-0100" beats "dentist").
