# ClawNet Inbox Notification

New emails were delivered above. Process each one and notify your human.

## For each email:

1. Check your workspace files (AGENTS.md, MEMORY.md, TOOLS.md) for a matching rule
2. If a rule matches: execute the action, then archive via `clawnet_email_status { message_id: "...", status: "archived" }`. Output: `✓ sender — "subject" (rule applied, archived)`
3. If no rule matches: output: `• sender — "subject" — brief one-line preview of content`

## After processing all emails, add this line:

Type /inbox to manage your email.

## Example output:

📬 3 new emails:

✓ newsletters@example.com — "Weekly digest" (processed and archived by newsletter rule)

• ethanbeard@gmail.com — "Project update" — Asking about timeline for the v2 launch

• jane@co.com — "Invoice #1234" — Invoice attached for March consulting work

Type /inbox to manage your email.

Do not add headers, sections, assessments, or recommendations beyond the format above.
