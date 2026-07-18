# Communications Awareness

You maintain a communications log to avoid duplicate or redundant **proactive** outreach. Scheduled reports and user-requested messages are always fine to send — dedup only applies to agent-initiated messages.

## Communications Log

File: `data/comms-log.jsonl` — append-only JSONL, one entry per outbound message.

### Before sending a PROACTIVE message

Dedup applies only when **you** decide to reach out (not when fulfilling a user request or running a scheduled job).

1. **Read the comms log** — `Read data/comms-log.jsonl` (tail last 50-100 lines if large). If the file exceeds 500 lines, only read the last 100.
2. **Check for recent similar outreach** — same recipient + similar topic within the last 24h = skip or significantly alter the message
3. **For Slack** — the mcp-slack-use skill already requires reading channel history before posting (rule #6). That check + this log together cover both same-session and cross-session duplicates.

### What counts as a duplicate (proactive only)

- Same recipient + same topic/intent within 24h → **skip entirely**
- Same recipient + related topic within 24h → **reference the prior message** instead of repeating context
- Same channel + same information within 48h → **skip or reply in thread** to the original

### After sending a message

Append one line to `data/comms-log.jsonl`:

```json
{"ts":"2026-05-20T10:30:00Z","channel":"#general","channelId":"C123","recipient":"@alice","via":"slack","trigger":"proactive","summary":"Asked about Q1 report status"}
```

Fields:
- **ts** — ISO timestamp
- **channel** — human-readable channel/thread name
- **channelId** — Slack channel ID (or email address for email, or E.164 phone number for phone/sms)
- **recipient** — who the message is directed at (can be "channel" for broadcast)
- **via** — `slack` | `slack-dm` | `email` | `phone` | `sms` (phone/sms via mcp-twilio)
- **trigger** — `proactive` (agent-initiated), `scheduled` (cron/scheduled job), or `requested` (user asked for it). **Dedup only applies to `proactive`.**
- **summary** — one-line summary of what was communicated (not the full message)

### Housekeeping

The log is append-only and can grow. When it exceeds ~500 lines, trim entries older than 7 days — recent history is what matters for dedup.

### Rules (proactive messages)

- **Never send the same information twice** to the same person/channel within 24h
- **Never nag** — if you've already asked someone for something and they haven't responded, don't ask again the same day
- **Consolidate** — if you have multiple things to tell the same person, batch them into one message
- **Phone calls and SMS are real-world interruptions** — only place a proactive call/SMS (mcp-twilio) when explicitly asked or for a genuine, time-sensitive reason. Never cold-call or text someone you weren't told to contact, and never dial multiple people without being asked.

### General

- **Always log** — append to the comms log after every outbound message, regardless of trigger type
- **Be self-aware** — read the log at the start of any task that involves communication to understand your recent activity
