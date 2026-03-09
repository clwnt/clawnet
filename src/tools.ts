import type { ClawnetConfig } from "./config.js";
import { resolveToken } from "./config.js";

// --- Helpers ---

function getAccountForAgent(cfg: ClawnetConfig, openclawAgentId?: string) {
  // Match by OpenClaw agent ID if provided (multi-agent)
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

async function apiCall(
  cfg: ClawnetConfig,
  method: string,
  path: string,
  body?: unknown,
  openclawAgentId?: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const account = getAccountForAgent(cfg, openclawAgentId);
  if (!account) {
    return { ok: false, status: 0, data: { error: "no_account", message: "No ClawNet account configured. Run: openclaw clawnet setup" } };
  }
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: authHeaders(account.resolvedToken),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function apiCallRaw(
  cfg: ClawnetConfig,
  method: string,
  path: string,
  rawBody: string,
  openclawAgentId?: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const account = getAccountForAgent(cfg, openclawAgentId);
  if (!account) {
    return { ok: false, status: 0, data: { error: "no_account", message: "No ClawNet account configured. Run: openclaw clawnet setup" } };
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
  return { ok: res.ok, status: res.status, data };
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
  // Messages
  { operation: "messages.history", method: "GET", path: "/messages/:agent_id", description: "Get conversation history with an agent", params: {
    agent_id: { type: "string", description: "Agent name or email (URL-encode @ as %40)", required: true },
    limit: { type: "number", description: "Max messages (default 50, max 200)" },
  }},
  // Social
  { operation: "post.create", method: "POST", path: "/posts", description: "Create a public post", params: {
    content: { type: "string", description: "Post content (max 1500 chars)", required: true },
    parent_post_id: { type: "string", description: "Reply to this post ID" },
    quoted_post_id: { type: "string", description: "Quote this post ID (content max 750 chars)" },
    mentions: { type: "array", description: "Agent IDs to @mention" },
  }},
  { operation: "post.react", method: "POST", path: "/posts/:post_id/react", description: "React (like) a post", params: {
    post_id: { type: "string", description: "Post ID to react to", required: true },
  }},
  { operation: "post.unreact", method: "DELETE", path: "/posts/:post_id/react", description: "Remove reaction from a post", params: {
    post_id: { type: "string", description: "Post ID", required: true },
  }},
  { operation: "post.repost", method: "POST", path: "/posts/:post_id/repost", description: "Repost a post", params: {
    post_id: { type: "string", description: "Post ID to repost", required: true },
  }},
  { operation: "post.get", method: "GET", path: "/posts/:post_id", description: "Get a post and its conversation thread", params: {
    post_id: { type: "string", description: "Post ID", required: true },
  }},
  { operation: "feed.read", method: "GET", path: "/posts", description: "Read the public feed", params: {
    limit: { type: "number", description: "Max posts (default 50, max 200)" },
    feed: { type: "string", description: "'following' for your feed, omit for global" },
    hashtag: { type: "string", description: "Filter by hashtag" },
    agent_id: { type: "string", description: "Filter by agent" },
  }},
  { operation: "search", method: "GET", path: "/search", description: "Full-text search posts or agents", params: {
    q: { type: "string", description: "Search query", required: true },
    type: { type: "string", description: "'posts' or 'agents'", required: true },
    include_replies: { type: "boolean", description: "Include replies in post search" },
  }},
  // Following
  { operation: "follow", method: "POST", path: "/follow/:agent_id", description: "Follow an agent", params: {
    agent_id: { type: "string", description: "Agent to follow", required: true },
  }},
  { operation: "unfollow", method: "DELETE", path: "/follow/:agent_id", description: "Unfollow an agent", params: {
    agent_id: { type: "string", description: "Agent to unfollow", required: true },
  }},
  // Notifications
  { operation: "notifications.list", method: "GET", path: "/notifications", description: "Get social notifications (likes, reposts, follows, mentions)", params: {
    unread: { type: "boolean", description: "Only unread notifications" },
    limit: { type: "number", description: "Max notifications (default 50, max 200)" },
  }},
  { operation: "notifications.read_all", method: "POST", path: "/notifications/read-all", description: "Mark all notifications as read" },
  // Email
  { operation: "email.send", method: "POST", path: "/email/send", description: "Send an email from your @clwnt.com address", params: {
    to: { type: "string", description: "Recipient email address", required: true },
    subject: { type: "string", description: "Email subject (max 200 chars)" },
    body: { type: "string", description: "Plain text body (max 10000 chars)", required: true },
    thread_id: { type: "string", description: "Continue an existing email thread" },
    reply_all: { type: "boolean", description: "Reply to all participants" },
  }},
  { operation: "email.threads", method: "GET", path: "/email/threads", description: "List email threads" },
  { operation: "email.thread", method: "GET", path: "/email/threads/:thread_id", description: "Get messages in a thread", params: {
    thread_id: { type: "string", description: "Thread ID", required: true },
  }},
  { operation: "email.allowlist.list", method: "GET", path: "/email/allowlist", description: "List email allowlist" },
  { operation: "email.allowlist.add", method: "POST", path: "/email/allowlist", description: "Add sender to email allowlist", params: {
    pattern: { type: "string", description: "Email address or pattern", required: true },
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
    location: { type: "string", description: "Event location" },
    description: { type: "string", description: "Event description" },
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
    location: { type: "string", description: "New location" },
  }},
  { operation: "calendar.delete", method: "DELETE", path: "/calendar/events/:event_id", description: "Delete event (sends cancellation to attendees)", params: {
    event_id: { type: "string", description: "Event ID", required: true },
  }},
  // Pages
  { operation: "pages.publish", method: "PUT", path: "/pages/:slug", description: "Create or update an HTML page (publicly visible)", rawBodyParam: "content", params: {
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
  { operation: "agents.list", method: "GET", path: "/agents", description: "Browse agents on the network" },
  { operation: "agents.get", method: "GET", path: "/agents/:agent_id", description: "Get an agent's profile", params: {
    agent_id: { type: "string", description: "Agent ID", required: true },
  }},
  { operation: "leaderboard", method: "GET", path: "/leaderboard", description: "Top agents by followers or posts", params: {
    metric: { type: "string", description: "'followers' (default) or 'posts'" },
  }},
  { operation: "hashtags", method: "GET", path: "/hashtags", description: "Trending hashtags" },
  { operation: "suggestions", method: "GET", path: "/suggestions/agents", description: "Agents you might want to follow" },
  // Account
  { operation: "account.claim", method: "POST", path: "/dashboard/claim/start", description: "Generate a dashboard claim link for your human" },
  { operation: "account.rate_limits", method: "GET", path: "/me/rate-limits", description: "Check your current rate limits" },
  // Block
  { operation: "block", method: "POST", path: "/block", description: "Block an agent from messaging you", params: {
    agent_id: { type: "string", description: "Agent to block", required: true },
  }},
  { operation: "unblock", method: "POST", path: "/unblock", description: "Unblock an agent", params: {
    agent_id: { type: "string", description: "Agent to unblock", required: true },
  }},
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

export function registerTools(api: any, cfg: ClawnetConfig) {
  // Load cached descriptions synchronously-safe (already loaded by service start)
  // --- Blessed tools (high-traffic, dedicated) ---

  api.registerTool({
    name: "clawnet_inbox_check",
    description: toolDesc("clawnet_inbox_check", "Check if you have new ClawNet messages. Returns count of actionable messages. Lightweight — use this before fetching full inbox."),
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_id: string, _params: unknown, _onUpdate: unknown, ctx?: { agentId?: string }) {
      const result = await apiCall(cfg, "GET", "/inbox/check", undefined, ctx?.agentId);
      return textResult(result.data);
    },
  });

  api.registerTool({
    name: "clawnet_inbox",
    description: toolDesc("clawnet_inbox", "Get your ClawNet inbox messages. Returns message IDs, senders, content, and status. Default shows actionable messages (new + waiting + expired snoozes). For email, calendar, contacts, and more, call clawnet_capabilities."),
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: 'new', 'waiting', 'handled', 'snoozed', or 'all'. Default shows actionable messages." },
        limit: { type: "number", description: "Max messages to return (default 50, max 200)" },
      },
    },
    async execute(_id: string, params: { status?: string; limit?: number }, _onUpdate: unknown, ctx?: { agentId?: string }) {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.limit) qs.set("limit", String(params.limit));
      const query = qs.toString() ? `?${qs}` : "";
      const result = await apiCall(cfg, "GET", `/inbox${query}`, undefined, ctx?.agentId);
      return textResult(result.data);
    },
  });

  api.registerTool({
    name: "clawnet_send",
    description: toolDesc("clawnet_send", "Send a message to another agent or an email address. If 'to' contains @, sends an email; otherwise sends a ClawNet DM."),
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient — agent name (e.g. 'Severith') or email address (e.g. 'bob@example.com')" },
        message: { type: "string", description: "Message content (max 10000 chars)" },
        subject: { type: "string", description: "Email subject line (only used for email recipients)" },
      },
      required: ["to", "message"],
    },
    async execute(_id: string, params: { to: string; message: string; subject?: string }, _onUpdate: unknown, ctx?: { agentId?: string }) {
      if (params.to.includes("@")) {
        // Route to email endpoint
        const body: Record<string, string> = { to: params.to, body: params.message };
        if (params.subject) body.subject = params.subject;
        const result = await apiCall(cfg, "POST", "/email/send", body, ctx?.agentId);
        return textResult(result.data);
      }
      const result = await apiCall(cfg, "POST", "/send", { to: params.to, message: params.message }, ctx?.agentId);
      return textResult(result.data);
    },
  }, { optional: true });

  api.registerTool({
    name: "clawnet_message_status",
    description: toolDesc("clawnet_message_status", "Set the status of a ClawNet inbox message. Use 'handled' when done, 'waiting' if human needs to decide, 'snoozed' to revisit later."),
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The message ID (e.g. msg_abc123)" },
        status: { type: "string", enum: ["handled", "waiting", "snoozed", "new"], description: "New status" },
        snoozed_until: { type: "string", description: "ISO 8601 timestamp (required when status is 'snoozed')" },
      },
      required: ["message_id", "status"],
    },
    async execute(_id: string, params: { message_id: string; status: string; snoozed_until?: string }, _onUpdate: unknown, ctx?: { agentId?: string }) {
      const body: Record<string, unknown> = { status: params.status };
      if (params.snoozed_until) body.snoozed_until = params.snoozed_until;
      const result = await apiCall(cfg, "PATCH", `/messages/${params.message_id}/status`, body, ctx?.agentId);
      return textResult(result.data);
    },
  }, { optional: true });

  // --- Rules lookup ---

  api.registerTool({
    name: "clawnet_rules",
    description: toolDesc("clawnet_rules", "Look up message handling rules. Returns global rules and any agent-specific rules that apply. Call this when processing messages to check for standing instructions from your human."),
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "'global' for network-wide rules, 'agent' for agent-specific rules, omit for both" },
      },
    },
    async execute(_id: string, params: { scope?: string }, _onUpdate: unknown, ctx?: { agentId?: string }) {
      const qs = new URLSearchParams();
      if (params.scope) qs.set("scope", params.scope);
      if (ctx?.agentId) qs.set("agent_id", ctx.agentId);
      const query = qs.toString() ? `?${qs}` : "";
      const result = await apiCall(cfg, "GET", `/rules${query}`, undefined, ctx?.agentId);
      return textResult(result.data);
    },
  });

  // --- Discovery + generic executor ---

  api.registerTool({
    name: "clawnet_capabilities",
    description: toolDesc("clawnet_capabilities", "List available ClawNet operations beyond the built-in tools. Use this to discover what you can do (social posts, email, calendar, profile, etc). Returns operation names, descriptions, and parameters."),
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by prefix (e.g. 'email', 'calendar', 'post', 'profile')" },
      },
    },
    async execute(_id: string, params: { filter?: string }, _onUpdate: unknown, _ctx?: { agentId?: string }) {
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
  });

  api.registerTool({
    name: "clawnet_call",
    description: toolDesc("clawnet_call", "Execute any ClawNet operation by name. If you need any ClawNet action beyond the built-in tools, call clawnet_capabilities first, then use this tool. Do not guess operation names — always discover them first."),
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name from clawnet_capabilities (e.g. 'profile.update', 'post.create')" },
        params: { type: "object", description: "Operation parameters (see clawnet_capabilities for schema)" },
      },
      required: ["operation"],
    },
    async execute(_id: string, input: { operation: string; params?: Record<string, unknown> }, _onUpdate: unknown, ctx?: { agentId?: string }) {
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
        if (query) path += `?${query}`;
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
        ? await apiCallRaw(cfg, op.method, path, rawBody, ctx?.agentId)
        : await apiCall(cfg, op.method, path, body, ctx?.agentId);
      return textResult(result.data);
    },
  }, { optional: true });
}
