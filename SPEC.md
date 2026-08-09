# Windsor Specification: Implementation Guide

## Channel Behavior Mapping

The server UI always immediately saves all config changes.

In the server config UI webpage, we see a list of channel->behavior mapping rows. Clicking on a row allows the user to see sub-configuration for that behavior (e.g. footer text). They can also delete a row. There's adjacent UI with a list of unmapped channels and list of behaviors; the user can pick one of each and then click "Add" to create the behavior mapping.

Internally, we store configuration in terms of both the channel name and ID, and match based on what we see on server startup or refresh: If the ID matches, use that and update our name. If none of the IDs match, see if a channel with the right name exists, update the ID instead. If neither exist, just delete that configuraiton entry. Be careful to not accidently nuke all config if we're encountering a server availabiliy blip - if *all* channels are missing, probably something has gone wrong, don't delete the config.

Channels may only have one behavior.

## URL Detection and Transformation

URLs are detected as any `https://...` text; we don't need to support other protocols. Trailing punctuation is ignored.

If multiple URLs are in the same message, write `[link 1]`, `[link 2]`, etc, instead of `[link]`. Don't try to dedupe URLs. There is a maximum of 5 links per printout. If URL parsing fails, assume it wasn't a URL in the first pace. If a URL is too long to generate a printable QR code for, assume it wasn't a URL in the first place.

## Idempotency

The bot does not require or assume 24/7 uptime. On startup you should scan prior messages and see what needs acting on. You only need to look at the last 100 messages per channel (500 for recurrences - assume we do not have more than that); messages older than this can be assumed to already be actioned.

For non-recurring items, use **reactions** to indicate that you've complied (e.g. printed or whatever) to a request. Use the ✅ reaction upon successfully fulfilling the request.

If printing fails, react with ⏸️ and post a reply that explains what went wrong. If the
printer device is unavailable, react with ⏳ instead and retry every 3 seconds until it
returns; then print the pending job and replace ⏳ with ✅. On startup, ⏳ reactions are
treated as pending jobs and retried.

The intended user workflow on fixing a printer is to power-cycle the Raspberry Pi, so you should attempt to re-process these messages on startup.

## Print Layout

In general we assume an 80mm printer. Long text should be wrapped. Extremely long messages (800 characters (?) after stripping URLs) should be ignored and reacted with ⁉️.

For message content, we generally want to print at quite a large font, for readability. This should scale down for longer messages; our ideal is that we are printing something that is modestly square to rectangular (not a tiny strip, not a CVS receipt). Images should span the full width of the paper minus a small margin.

General format is:

 * User-specified header (large font)
 * Primary text (medium-large font, depending)
 * Icon
 * QR codes
 * User-specified footer (medium font)
 * Metadata footer (small font)

Timestamps are in local time, in the format `2026-08-17 7:34 PM`

## Message Ingestion

Ignore user attachments, images, embeds, etc.. Only look at primary message content.
Ignore replies.
Ignore messages from your own account.

If parsing fails, react with ⁉️ and reply with something sensible related to the parsing failure that occurred.

Editing a message does not re-trigger bot activity.

## Accumulating List Behavior

The message `print` (any casing, all spacing / punctuation ignored) triggers a print.
Print all items between this message and the prior print message (or 100 messages, whichever is shorter).
If this would yield 0 items, instead print the "previous" list (this would normally occur if the printer had run out of paper and the user is retrying).

Don't try to deduplicate items.
Ignore deleted messages in the chat.
Use the latest version of any edited message.

## Recurring Print Behavior

We need to extract two main things from the user's message:
 * The *message* part
 * The *schedule* part

Use structured output using a zod schema to implement this.

Send the AI a message in this form:

> The user has asked for a recurring printout. It is currently [the current date and time]. Tell me the next time that I should do this, and what the non-schedule part of the message was (verbatim). If the user didn't specify a time of day, use 8:00 AM. Here's the user's message: [the user message]

You'll want to get back a JSON blob like this:
```json
{
    "message without schedule": "take out the trash",
    "next occurrence": "2025-08-02 07:30 PM"
}
```
Be flexible about date parsing.

Use majority-reasoning method of asking 5 times. You must get 60% consistency in the message portion and 60% consistency in the next occurrence portion (not necessarily from the same responses); if this doesn't happen, treat this as a failure to parse and react appropriately.

React to the message with the standard green checkmark and reply with:

> Got it. I will print ⟪take out the trash⟫ at 2025-08-02 07:30 PM

You'll ingest this message on re-starts to establish what scheduled tasks there are.
Enqueue a background task that checks for scheduled items maturing (check every 30s).

When a task matures, we'll of course print it as requested.
When print finishes, react to the reply with the checkmark emoji.

Then we'll return to the AI to ask for what the next occurrence is.
Note that a task might have finite occurrences, e.g. the user prompt might be "for the next five weeks, remind me at 2 PM to take my medicine on Tuesdays".

So we'll post a reply either like

> This occurrence has expired and no more prints are scheduled

*or*

> Printed at 2025-08-02 07:30 PM. The next print will be at 2025-08-09 07:30 PM.

You can thus interpret the absence of such a reply (but the presence of the checkmark) as meaning the prior run failed to reach the AI server, and needs a retry.

## OpenAI Notes

Use `gpt-5.4-nano`, low reasoning, with structured outputs with zod v4 JSON schema for all tasks.

Keep a global rolling window of never consuming more than 200,000 tokens during any 24 hour period (something would be EXTREMELY wrong if this happens). If this happens, literally delete the AI key from your config.

## Icon Feature

For our auto-generated icon, we'll use OpenAI API. Use `gpt-image-1-mini`, 1024x1024, auto quality, transparency on, png format, with a prompt like

> Black-on-transparent line drawing icon for the TODO item: "take out the trash". Do not produce any text. Use big, thick lines. No fine detailing.

Once you get an image back, store it somewhere sensible on disk with a name like `1837c1a3e.png` where the name is derived from a SHA of the prompt. Check this cache first before calling out to the API.

If you're trying to print an item and the AI API is not working for some reason, retry up to 3 times, then just give up and skip the icon, it's never mandatory.

## On-Demand Commands and Interaction Model

Both `!command` and `/command` are supported.
Follow our standard idempotency model.
All users can run commands.

## Persistence and Data Model

We have three primary data sources:
 * Messages in the channel itself
 * Our own messages and reactions, which indicate work we've already done
 * Local config JSON file
 * In-memory log. This is where we persist logging, etc - we do not need to persist logging between server restarts

## Security and Access Control

In the server configuration page, users can optionally set a password (hash this and store it in the config file). Once this is set, the config server can only be accessed using that password; use WWW-Authenticate and ignore the username portion.

Channel security is up to Discord config; any user posting in a behavior-configured channel is assumed to be authorized to trigger whatever they're doing.

## Printer Integration

We only support ESC/P protocol, and there must be at most one printer installed.
The server configuration page should show what printer is connected (if any), offer appropriate printer config options, and have a "print test page button" that prints a small test page demonstrating printer capabilities (fonts, images, alignments, etc).

## Diagnostics

The server log, visible in the server config page, should show enough events to allow basic diagnostic health, e.g.
 * Successful discord gateway connection
 * Print success/fail

Do not include keepalive pings or other routine "non-events".

## Testing

Write tasteful unit tests at module boundaries. Test for behavorial acceptance, not hardcoded results, and don't test things that TypeScript is already covering for us. Tests must be typechecked. Don't test things that are too much of a pain in the ass.

## Revision notes: alpha

Apply these revisions to the spec or readme IF APPROPRIATE

 * It should be more apparent in the server config whether a Discord token has been set yet. Same for OpenAI. Don't actually hide these, just always show them
 * Use "server" in all user-facing config, never "guild"
 * Server ID is required
 * Setting the discord token and server ID should reload the channel list in the server UI
 * Fix this: "(node:49701) DeprecationWarning: The ready event has been renamed to clientReady to distinguish it from the gateway READY event and will only emit under that name in v15. Please use clientReady instead."
 * Add a "refresh channels" button to the server UI, next to the channel list
 * Remove all "back compat" code, you don't need to be backward compatible with anything, this is an alpha project
 * Command invocation should automatically trigger a log event without extra per-code command
 * Don't use `class` in this project, use a function/revealing-module pattern instead
 * Server config UI should have a "Restart Server" button
 * Don't show voice channels or forum channels in the channel listing
