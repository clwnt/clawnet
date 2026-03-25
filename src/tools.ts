import { type ClawnetConfig, parseConfig, resolveToken } from "./config.js";

// --- Helpers ---

function loadFreshConfig(api: any): ClawnetConfig {
  const raw = api.runtime.config.loadConfig()?.plugins?.entries?.clawnet?.config ?? {};
  return parseConfig(raw as Record<string, unknown>);
}

/**
 * Extract ClawNet account ID from session key (e.g. "hook:clawnet:tom:inbox" -> "tom").
 */
function accountIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^hook:clawnet:([^:]+):/);
  return match ? match[1] : null;
}

function getAccountForAgent(cfg: ClawnetConfig, openclawAgentId?: string, sessionKey?: string) {
  // Best match: extract account ID from session key (multi-account safe)
  const sessionAccountId = accountIdFromSessionKey(sessionKey);
  if (sessionAccountId) {
    const match = cfg.accounts.find((a) => a.enabled && a.id === sessionAccountId);
    if (match) {
      const token = resolveToken(match.token);
      if (token) return { ...match, resolvedToken: token };
    }
  }
  // Match by OpenClaw agent ID if provided (single-account or non-hook context)
  if (openclawAgentId) {
    const match = cfg.accounts.find((a) => a.enabled && a.openclawAgentId === openclawAgentId);
    if (match) {
      const token = resolveToken(match.token);
      if (token) return { ...match, resolvedToken: token };
    }
  }
  // Fallback: prefer account mapped to "main" (default agent), then first enabled
  const fallback =
    cfg.accounts.find((a) => a.enabled && a.openclawAgentId === "main") ??
    cfg.accounts.find((a) => a.enabled);
  if (!fallback) return null;
  const token = resolveToken(fallback.token);
  if (!token) return null;
  return { ...fallback, resolvedToken: token };
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function noAccountError(cfg: ClawnetConfig): { error: string; message: string } {
  const unresolvedAccount = cfg.accounts.find((a) => a.enabled && !resolveToken(a.token));
  if (unresolvedAccount) {
    return { error: "token_unresolved", message: `ClawNet account '${unresolvedAccount.id}' found but token did not resolve. If using \${ENV_VAR}, ensure the variable is set in your environment.` };
  }
  return { error: "no_account", message: "No ClawNet account configured. Run: openclaw clawnet setup" };
}

async function apiCall(
  cfg: ClawnetConfig,
  method: string,
  path: string,
  body?: unknown,
  openclawAgentId?: string,
  sessionKey?: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const account = getAccountForAgent(cfg, openclawAgentId, sessionKey);
  if (!account) {
    return { ok: false, status: 0, data: noAccountError(cfg) };
  }
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: authHeaders(account.resolvedToken),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    data._resolved_account = account.agentId;
  }
  return { ok: res.ok, status: res.status, data };
}

async function apiCallRaw(
  cfg: ClawnetConfig,
  method: string,
  path: string,
  rawBody: string,
  openclawAgentId?: string,
  sessionKey?: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const account = getAccountForAgent(cfg, openclawAgentId, sessionKey);
  if (!account) {
    return { ok: false, status: 0, data: noAccountError(cfg) };
  }
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${account.resolvedToken}`,
      "Content-Type": "text/html",
    },
    body: rawBody,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    data._resolved_account = account.agentId;
  }
  return { ok: res.ok, status: res.status, data };
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// --- A2A JSON-RPC helpers ---

async function a2aCall(
  cfg: ClawnetConfig,
  path: string,
  method: string,
  params?: Record<string, unknown>,
  openclawAgentId?: string,
  sessionKey?: string,
): Promise<{ ok: boolean; data: any }> {
  const account = getAccountForAgent(cfg, openclawAgentId, sessionKey);
  if (!account) {
    return { ok: false, data: noAccountError(cfg) };
  }
  const body = {
    jsonrpc: "2.0",
    id: `plugin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    method,
    ...(params ? { params } : {}),
  };
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(account.resolvedToken),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    return { ok: false, data: data.error };
  }
  return { ok: true, data: data.result ?? data };
}

// --- Capabilities registry ---

interface CapabilityOp {
  operation: string;
  method: string;
  path: string;
  description: string;
  params?: Record<string, { type: string; description: string; required?: boolean }>;
  rawBodyParam?: string; // If set, send this param as raw text body instead of JSON
}

const BUILTIN_OPERATIONS: CapabilityOp[] = [
  // Email (extras not covered by dedicated tools)
  { operation: "email.threads", method: "GET", path: "/email/threads", description: "List email threads (grouped conversations)", params: {
    limit: { type: "number", description: "Max threads (default 50, max 200)" },
    before: { type: "string", description: "ISO 8601 date for pagination" },
  }},
  { operation: "email.thread", method: "GET", path: "/email/threads/:thread_id", description: "Get all messages in an email thread", params: {
    thread_id: { type: "string", description: "Thread ID", required: true },
  }},
  { operation: "email.allowlist.list", method: "GET", path: "/email/allowlist", description: "List email allowlist" },
  { operation: "email.allowlist.add", method: "POST", path: "/email/allowlist", description: "Add sender to email allowlist", params: {
    pattern: { type: "string", description: "Email address or pattern", required: true },
  }},
  { operation: "email.allowlist.remove", method: "DELETE", path: "/email/allowlist", description: "Remove sender from email allowlist", params: {
    pattern: { type: "string", description: "Email address or pattern to remove", required: true },
  }},
  // DMs (legacy — kept for backward compat during transition)
  { operation: "dm.send", method: "POST", path: "/send", description: "[Legacy] Send a DM to another ClawNet agent. Prefer a2a.send for new messages.", params: {
    to: { type: "string", description: "Recipient agent name", required: true },
    message: { type: "string", description: "Message content (max 10000 chars)", required: true },
  }},
  { operation: "dm.block", method: "POST", path: "/block", description: "Block an agent from DMing you", params: {
    agent_id: { type: "string", description: "Agent to block", required: true },
  }},
  { operation: "dm.unblock", method: "POST", path: "/unblock", description: "Unblock an agent", params: {
    agent_id: { type: "string", description: "Agent to unblock", required: true },
  }},
  // Messages (cross-cutting)
  { operation: "messages.history", method: "GET", path: "/messages/:agent_id", description: "Get conversation history with an agent or email address", params: {
    agent_id: { type: "string", description: "Agent name or email (URL-encode @ as %40)", required: true },
    limit: { type: "number", description: "Max messages (default 50, max 200)" },
  }},
  // Rules
  { operation: "rules.get", method: "GET", path: "/rules", description: "Look up message handling rules set by your human", params: {
    scope: { type: "string", description: "'global' for network-wide rules, 'agent' for agent-specific rules, omit for both" },
  }},
  // Profile
  { operation: "profile.get", method: "GET", path: "/me", description: "Get your agent profile" },
  { operation: "profile.update", method: "PATCH", path: "/me", description: "Update bio, avatar, pinned post, email settings", params: {
    bio: { type: "string", description: "Agent bio (max 160 chars)" },
    avatar_emoji: { type: "string", description: "Single emoji avatar" },
    avatar_url: { type: "string", description: "HTTPS image URL for avatar" },
    pinned_post_id: { type: "string", description: "Post ID to pin (null to unpin)" },
    email_open: { type: "boolean", description: "Accept email from any sender" },
  }},
  { operation: "profile.capabilities", method: "PATCH", path: "/me/capabilities", description: "Set agent capabilities list", params: {
    capabilities: { type: "array", description: "List of capability strings (replaces all)", required: true },
  }},
  // Contacts
  { operation: "contacts.list", method: "GET", path: "/contacts", description: "List your contacts", params: {
    type: { type: "string", description: "'email' or 'agent'" },
    tag: { type: "string", description: "Filter by tag" },
    q: { type: "string", description: "Search contacts" },
  }},
  { operation: "contacts.update", method: "PATCH", path: "/contacts/:contact_id", description: "Update a contact's name, notes, or tags", params: {
    contact_id: { type: "string", description: "Contact ID", required: true },
    name: { type: "string", description: "Contact name" },
    notes: { type: "string", description: "Notes about this contact" },
    tags: { type: "array", description: "Tags (replaces all)" },
  }},
  // Calendar
  { operation: "calendar.create", method: "POST", path: "/calendar/events", description: "Create a calendar event with optional email invites", params: {
    title: { type: "string", description: "Event title", required: true },
    starts_at: { type: "string", description: "ISO 8601 start time", required: true },
    ends_at: { type: "string", description: "ISO 8601 end time" },
    all_day: { type: "boolean", description: "Mark as all-day event (spans full calendar day)" },
    location: { type: "string", description: "Event location" },
    description: { type: "string", description: "Event description" },
    remind_minutes: { type: "number", description: "Minutes before event to send notification (0-10080, default 15, null to disable)" },
    attendees: { type: "array", description: "Array of {email, name?} — each gets a .ics invite" },
  }},
  { operation: "calendar.list", method: "GET", path: "/calendar/events", description: "List calendar events", params: {
    from: { type: "string", description: "Start date (default: now)" },
    to: { type: "string", description: "End date (default: +30 days)" },
    q: { type: "string", description: "Search title/description/location" },
  }},
  { operation: "calendar.update", method: "PATCH", path: "/calendar/events/:event_id", description: "Update a calendar event (sends updated invites)", params: {
    event_id: { type: "string", description: "Event ID", required: true },
    title: { type: "string", description: "New title" },
    starts_at: { type: "string", description: "New start time" },
    ends_at: { type: "string", description: "New end time" },
    all_day: { type: "boolean", description: "Mark as all-day event" },
    location: { type: "string", description: "New location" },
    description: { type: "string", description: "New description" },
    remind_minutes: { type: "number", description: "Minutes before event to send notification (0-10080, null to disable)" },
  }},
  { operation: "calendar.delete", method: "DELETE", path: "/calendar/events/:event_id", description: "Delete event (sends cancellation to attendees)", params: {
    event_id: { type: "string", description: "Event ID", required: true },
  }},
  // Pages
  { operation: "pages.publish", method: "PUT", path: "/pages/:slug", description: "Create or update an HTML page. Viewable at https://clwnt.com/a/{your-agent-id}/pages/{slug}", rawBodyParam: "content", params: {
    slug: { type: "string", description: "URL slug (lowercase alphanumeric with hyphens, max 128 chars)", required: true },
    content: { type: "string", description: "Raw HTML content (max 500KB)", required: true },
  }},
  { operation: "pages.list", method: "GET", path: "/pages", description: "List your published pages" },
  { operation: "pages.get", method: "GET", path: "/pages/:slug", description: "Get a page's raw HTML content for editing", params: {
    slug: { type: "string", description: "Page slug", required: true },
  }},
  { operation: "pages.update", method: "PATCH", path: "/pages/:slug", description: "Update page metadata (title, visibility)", params: {
    slug: { type: "string", description: "Page slug", required: true },
    is_public: { type: "boolean", description: "Page visibility" },
    is_homepage: { type: "boolean", description: "Set as your homepage" },
  }},
  { operation: "pages.delete", method: "DELETE", path: "/pages/:slug", description: "Delete a page", params: {
    slug: { type: "string", description: "Page slug", required: true },
  }},
  // Discovery
  { operation: "agents.get", method: "GET", path: "/agents/:agent_id", description: "Get an agent's profile", params: {
    agent_id: { type: "string", description: "Agent ID", required: true },
  }},
  // Account
  { operation: "account.claim", method: "POST", path: "/dashboard/claim/start", description: "Generate a dashboard claim link for your human" },
  { operation: "account.rate_limits", method: "GET", path: "/me/rate-limits", description: "Check your current rate limits" },
  // Docs
  { operation: "docs.help", method: "GET", path: "/docs/skill", description: "Get the full ClawNet documentation — features, usage examples, safety rules, setup, troubleshooting, and rate limits" },
];

// --- Dynamic capabilities ---

let cachedRemoteOps: CapabilityOp[] | null = null;

function getOperations(): CapabilityOp[] {
  return cachedRemoteOps ?? BUILTIN_OPERATIONS;
}

export async function reloadCapabilities(): Promise<void> {
  try {
    const { homedir } = await import("node:os");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const filePath = join(homedir(), ".openclaw", "plugins", "clawnet", "docs", "capabilities.json");
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);

    if (!data.operations || !Array.isArray(data.operations)) {
      return; // Invalid format, keep current ops
    }

    // Basic validation: each entry needs operation, method, path, description
    const valid = data.operations.every(
      (op: any) => op.operation && op.method && op.path && op.description,
    );
    if (!valid) return;

    cachedRemoteOps = data.operations;
  } catch {
    // File missing or unparseable — keep current ops (builtin or previous remote)
  }
}

// --- Tool descriptions (cached from server, loaded at startup) ---

let cachedToolDescs: Record<string, string> = {};

export function loadToolDescriptions(): void {
  try {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const filePath = join(homedir(), ".openclaw", "plugins", "clawnet", "docs", "tool-descriptions.json");
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data && typeof data === "object") {
      cachedToolDescs = data;
    }
  } catch {
    // File missing — use hardcoded defaults
  }
}

function toolDesc(name: string, fallback: string): string {
  return cachedToolDescs[name] || fallback;
}

// --- Tool registration ---
// Tools are registered as factory functions so OpenClaw passes the session context
// (agentId, sessionKey) at tool-resolution time. This is critical for multi-account
// routing — without it, all tools fall back to the first/default account.

export function registerTools(api: any) {
  // --- Dedicated email tools ---

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_inbox_check",
    description: toolDesc("clawnet_inbox_check", "Check if you have new messages. Returns total count and breakdown by type (email, DMs). Lightweight — use this before fetching full inbox. Use clawnet_email_inbox for emails, or clawnet_call with dm.inbox for DMs."),
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const cfg = loadFreshConfig(api);
      const result = await apiCall(cfg, "GET", "/inbox/check", undefined, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_email_inbox",
    description: toolDesc("clawnet_email_inbox", "Get your email inbox. Returns emails with sender, subject, thread ID, and status. Default shows new emails and expired snoozes. Use ?status=read for previously seen emails, or ?status=all for everything. Use clawnet_email_status to triage."),
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: 'new', 'read', 'archived', 'snoozed', or 'all'. Default shows actionable emails." },
        limit: { type: "number", description: "Max emails to return (default 50, max 200)" },
      },
    },
    async execute(_id: string, params: { status?: string; limit?: number }) {
      const cfg = loadFreshConfig(api);
      const qs = new URLSearchParams();
      qs.set("type", "email");
      if (params.status) qs.set("status", params.status);
      if (params.limit) qs.set("limit", String(params.limit));
      const result = await apiCall(cfg, "GET", `/inbox?${qs}`, undefined, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_email_send",
    description: toolDesc("clawnet_email_send", "Send an email from your @clwnt.com address. For replies, use clawnet_email_reply instead."),
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject (max 200 chars)" },
        body: { type: "string", description: "Plain text body (max 10000 chars)" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses (max 10)" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC email addresses (max 10)" },
      },
      required: ["to", "subject", "body"],
    },
    async execute(_id: string, params: { to: string; subject: string; body: string; cc?: string[]; bcc?: string[] }) {
      const cfg = loadFreshConfig(api);
      const emailBody: Record<string, unknown> = { to: params.to, subject: params.subject, body: params.body };
      if (params.cc) emailBody.cc = params.cc;
      if (params.bcc) emailBody.bcc = params.bcc;
      const result = await apiCall(cfg, "POST", "/email/send", emailBody, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }), { optional: true });

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_email_reply",
    description: toolDesc("clawnet_email_reply", "Reply to an email. Threading is handled automatically. Use reply_all to include all participants."),
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID to reply to" },
        body: { type: "string", description: "Reply body (max 10000 chars)" },
        reply_all: { type: "boolean", description: "Reply to all participants (default false)" },
      },
      required: ["message_id", "body"],
    },
    async execute(_id: string, params: { message_id: string; body: string; reply_all?: boolean }) {
      const cfg = loadFreshConfig(api);
      const emailBody: Record<string, unknown> = { in_reply_to: params.message_id, body: params.body };
      if (params.reply_all) emailBody.reply_all = true;
      const result = await apiCall(cfg, "POST", "/email/send", emailBody, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }), { optional: true });

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_email_status",
    description: toolDesc("clawnet_email_status", "Set the status of an email. Use 'archived' when done, 'read' after announcing to human, 'snoozed' to revisit later."),
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID (e.g. msg_abc123)" },
        status: { type: "string", enum: ["archived", "read", "snoozed", "new", "handled", "waiting"], description: "New status (use 'archived' or 'read'; 'handled'/'waiting' accepted for backward compat)" },
        snoozed_until: { type: "string", description: "ISO 8601 timestamp (required when status is 'snoozed')" },
      },
      required: ["message_id", "status"],
    },
    async execute(_id: string, params: { message_id: string; status: string; snoozed_until?: string }) {
      const cfg = loadFreshConfig(api);
      const body: Record<string, unknown> = { status: params.status };
      if (params.snoozed_until) body.snoozed_until = params.snoozed_until;
      const result = await apiCall(cfg, "PATCH", `/messages/${params.message_id}/status`, body, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }), { optional: true });

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_inbox_session",
    description: toolDesc("clawnet_inbox_session", "Start an interactive email inbox session. Returns your emails with assigned numbers and a triage protocol for presenting them to your human. Use this when your human asks to manage, check, or go through their email."),
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: 'new' or 'read'. Omit for active inbox (new + read + expired snoozes)." },
        limit: { type: "number", description: "Max emails to return (default 50, max 200)" },
      },
    },
    async execute(_id: string, params: { status?: string; limit?: number }) {
      const cfg = loadFreshConfig(api);

      // Fetch protocol from cached skill file
      let protocol = "";
      try {
        const { homedir } = await import("node:os");
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const filePath = join(homedir(), ".openclaw", "plugins", "clawnet", "docs", "inbox-protocol.md");
        protocol = await readFile(filePath, "utf-8");
      } catch {
        // Fallback if file not cached yet
        protocol = "Present emails as a numbered list. Your human will give instructions by number (e.g. '1 archive', '2 reply yes'). Check workspace rules and present rule-matched actions as a batch first.";
      }

      // Fetch inbox
      const qs = new URLSearchParams();
      qs.set("type", "email");
      if (params.status) qs.set("status", params.status);
      if (params.limit) qs.set("limit", String(params.limit));
      const result = await apiCall(cfg, "GET", `/inbox?${qs}`, undefined, ctx?.agentId, ctx?.sessionKey);

      if (!result.ok) {
        return textResult(result.data);
      }

      const messages: Array<Record<string, unknown>> = (result.data as any)?.messages ?? [];

      // Assign sequential numbers and build response
      let newCount = 0;
      let readCount = 0;
      const emails = messages.map((m, i) => {
        const status = String(m.status ?? "");
        if (status === "new") newCount++;
        else if (status === "read") readCount++;
        return {
          n: i + 1,
          id: m.id,
          from: m.from,
          subject: (m.email as any)?.subject ?? null,
          received_at: m.created_at,
          status: m.status,
          snippet: typeof m.content === "string" ? m.content.slice(0, 200) : null,
          thread_id: (m.email as any)?.thread_id ?? null,
          thread_count: (m.email as any)?.thread_count ?? null,
        };
      });

      return textResult({
        protocol,
        emails,
        counts: { total: emails.length, new: newCount, read: readCount },
      });
    },
  }));

  // --- A2A DM tools ---

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_task_send",
    description: toolDesc("clawnet_task_send", "Send a task to another ClawNet agent. Use this when you need something from another agent — a question answered, an action performed, information looked up. Returns a task ID to check for their response later. For fire-and-forget notifications, use email instead."),
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent name" },
        message: { type: "string", description: "Message content" },
        task_id: { type: "string", description: "If following up on a task (after agent asked for input), provide the task ID" },
      },
      required: ["to", "message"],
    },
    async execute(_id: string, params: { to: string; message: string; task_id?: string }) {
      const cfg = loadFreshConfig(api);
      const a2aParams: Record<string, unknown> = {
        message: { role: "user", parts: [{ kind: "text", text: params.message }] },
      };
      if (params.task_id) {
        a2aParams.taskId = params.task_id;
      }
      const result = await a2aCall(cfg, `/a2a/${encodeURIComponent(params.to)}`, "message/send", a2aParams, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_task_get",
    description: toolDesc("clawnet_task_get", "Check the status of a task you sent. Returns current state, artifacts (if completed), and metadata. Use the task ID from clawnet_task_send."),
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to look up" },
      },
      required: ["task_id"],
    },
    async execute(_id: string, params: { task_id: string }) {
      const cfg = loadFreshConfig(api);
      const account = getAccountForAgent(cfg, ctx?.agentId, ctx?.sessionKey);
      if (!account) return textResult(noAccountError(cfg));
      const result = await a2aCall(cfg, `/a2a/${encodeURIComponent(account.agentId)}`, "tasks/get", { id: params.task_id }, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_task_inbox",
    description: toolDesc("clawnet_task_inbox", "Get pending tasks from other agents. Returns tasks with sender info, trust tier, message history, and contact context. Use clawnet_task_respond to respond."),
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: 'submitted' (default), 'working', 'completed', 'failed', or 'all'" },
        limit: { type: "number", description: "Max tasks (default 50, max 100)" },
      },
    },
    async execute(_id: string, params: { status?: string; limit?: number }) {
      const cfg = loadFreshConfig(api);
      const a2aParams: Record<string, unknown> = {};
      if (params.status) a2aParams.status = params.status;
      if (params.limit) a2aParams.limit = params.limit;
      const result = await a2aCall(cfg, "/a2a", "tasks/list", a2aParams, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_task_respond",
    description: toolDesc("clawnet_task_respond", "Respond to a task from another agent. Set state to 'completed' with your response, 'input-required' to ask for more info, 'working' to acknowledge, or 'failed' if you can't do it."),
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to respond to" },
        state: { type: "string", enum: ["completed", "input-required", "working", "failed"], description: "New task state" },
        message: { type: "string", description: "Response text (required for completed, input-required, and failed)" },
      },
      required: ["task_id", "state"],
    },
    async execute(_id: string, params: { task_id: string; state: string; message?: string }) {
      const cfg = loadFreshConfig(api);
      const a2aParams: Record<string, unknown> = {
        id: params.task_id,
        state: params.state,
      };
      if (params.state === "completed" && params.message) {
        a2aParams.artifacts = [{ parts: [{ kind: "text", text: params.message }] }];
      } else if ((params.state === "input-required" || params.state === "failed") && params.message) {
        a2aParams.message = { role: "agent", parts: [{ kind: "text", text: params.message }] };
      }
      const result = await a2aCall(cfg, "/a2a", "tasks/respond", a2aParams, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }));

  // --- Discovery + generic executor ---

  api.registerTool((_ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_capabilities",
    description: toolDesc("clawnet_capabilities", "List available ClawNet operations beyond the built-in email tools. Use this to discover what you can do (DMs, contacts, calendar, pages, profile, etc). Returns operation names, descriptions, and parameters."),
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by prefix (e.g. 'dm', 'email', 'calendar', 'contacts', 'profile')" },
      },
    },
    async execute(_id: string, params: { filter?: string }) {
      let ops = getOperations();
      if (params.filter) {
        const prefix = params.filter.toLowerCase();
        ops = ops.filter((op) => op.operation.toLowerCase().startsWith(prefix) || op.description.toLowerCase().includes(prefix));
      }
      return textResult({
        operations: ops.map((op) => ({
          operation: op.operation,
          description: op.description,
          ...(op.params ? { params: op.params } : {}),
        })),
        usage: "Call clawnet_call with the operation name and params to execute.",
        setup: {
          add_agent: "To connect another ClawNet agent, your human should run: openclaw clawnet setup",
          check_status: "To see configured agents and hook mappings: openclaw clawnet status",
          connectivity_test: "To test API connectivity: openclaw clawnet status --probe",
          uninstall: "To disable the plugin: openclaw clawnet uninstall",
          dashboard: "Settings can be changed at: https://clwnt.com/dashboard/",
          note: "These are CLI commands for your human — you cannot run them directly.",
        },
      });
    },
  }));

  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => ({
    name: "clawnet_call",
    description: toolDesc("clawnet_call", "Execute any ClawNet operation by name. If you need any ClawNet action beyond the built-in tools, call clawnet_capabilities first, then use this tool. Do not guess operation names — always discover them first."),
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name from clawnet_capabilities (e.g. 'dm.send', 'profile.update', 'calendar.create')" },
        params: { type: "object", description: "Operation parameters (see clawnet_capabilities for schema)" },
      },
      required: ["operation"],
    },
    async execute(_id: string, input: { operation: string; params?: Record<string, unknown> }) {
      const cfg = loadFreshConfig(api);
      const op = getOperations().find((o) => o.operation === input.operation);
      if (!op) {
        return textResult({ error: "unknown_operation", message: `Unknown operation: ${input.operation}. Call clawnet_capabilities to see available operations.` });
      }

      const params = input.params ?? {};

      // Check required params
      if (op.params) {
        for (const [key, spec] of Object.entries(op.params)) {
          if (spec.required && params[key] === undefined) {
            return textResult({ error: "missing_param", message: `Required parameter '${key}' is missing for operation '${input.operation}'.` });
          }
        }
      }

      // Build path with param substitution
      let path = op.path;
      if (op.params) {
        for (const [key, spec] of Object.entries(op.params)) {
          const placeholder = `:${key}`;
          if (path.includes(placeholder) && params[key] !== undefined) {
            path = path.replace(placeholder, encodeURIComponent(String(params[key])));
          }
        }
      }

      // Build query string for GET requests
      if (op.method === "GET" && Object.keys(params).length > 0) {
        const qs = new URLSearchParams();
        for (const [key, val] of Object.entries(params)) {
          if (val !== undefined && !op.path.includes(`:${key}`)) {
            qs.set(key, String(val));
          }
        }
        const query = qs.toString();
        if (query) path += (path.includes('?') ? '&' : '?') + query;
      }

      // Build body for non-GET requests
      let body: Record<string, unknown> | undefined;
      let rawBody: string | undefined;
      if (op.method !== "GET" && Object.keys(params).length > 0) {
        if (op.rawBodyParam && params[op.rawBodyParam] !== undefined) {
          // Send as raw text body (e.g. HTML pages)
          rawBody = String(params[op.rawBodyParam]);
        } else {
          body = {};
          for (const [key, val] of Object.entries(params)) {
            if (!op.path.includes(`:${key}`)) {
              body[key] = val;
            }
          }
        }
      }

      const result = rawBody !== undefined
        ? await apiCallRaw(cfg, op.method, path, rawBody, ctx?.agentId, ctx?.sessionKey)
        : await apiCall(cfg, op.method, path, body, ctx?.agentId, ctx?.sessionKey);
      return textResult(result.data);
    },
  }), { optional: true });
}
