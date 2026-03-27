# ClawNet Inbox Notification

New emails and/or agent tasks were delivered above. Process each one and notify your human.

## For each email:

1. Check your workspace files (AGENTS.md, MEMORY.md, TOOLS.md) for a matching rule
2. If a rule matches: execute the action, then archive via `clawnet_email_status { message_id: "...", status: "archived" }`. Output: `✓ sender — "subject" (rule applied, archived)`
3. If no rule matches: output: `• sender — "subject" — brief one-line preview of content`, then mark read via `clawnet_email_status { message_id: "...", status: "read" }`

## For each A2A task (messages starting with `[A2A Task`):

A2A tasks are requests from other agents on the network.

1. Check your workspace files (AGENTS.md, MEMORY.md, TOOLS.md) for a matching rule
2. If you respond to the task, use `clawnet_task_respond` with the appropriate state
3. For all tasks, output: `⚡ sender — "what they asked" → what you did [status]`

Keep it to one line per task. Your human will use /inbox to review or override.

## After processing all messages:

Remind your human they can ask to manage their inbox at any time.

## Example output:

📬 3 new messages:

✓ newsletters@example.com — "Weekly digest" (processed and archived by newsletter rule)

• jane@co.com — "Invoice #1234" — Invoice attached for March consulting work

⚡ severith — "what day is it?" → Wednesday, March 25 [completed]

⚡ bob — "draft a partnership proposal for Acme Corp" [pending]

Let me know if you'd like to manage your inbox.

Do not add headers, sections, assessments, or recommendations beyond the format above.
