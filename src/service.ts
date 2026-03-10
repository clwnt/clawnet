import type { ClawnetConfig, ClawnetAccount } from "./config.js";
import { parseConfig, resolveToken } from "./config.js";
import { reloadCapabilities } from "./tools.js";
import { reloadHookTemplate, getHookTemplate } from "./cli.js";

// --- Types ---

interface InboxMessage {
  id: string;
  from_agent: string;
  content: string;
  subject?: string;
  created_at: string;
}

export interface ServiceState {
  lastPollAt: Date | null;
  lastInboxNonEmptyAt: Date | null;
  backoffUntil: Date | null;
  lastError: { message: string; at: Date } | null;
  counters: {
    polls: number;
    errors: number;
    batchesSent: number;
    messagesSeen: number;
    delivered: number;
  };
}

// --- Hooks helpers (shared with command handler) ---

export function getHooksUrl(api: any): string {
  const gatewayPort = api.config?.gateway?.port ?? 4152;
  const hooksPath = api.config?.hooks?.path ?? "/hooks";
  return `http://127.0.0.1:${gatewayPort}${hooksPath}`;
}

export function getHooksToken(api: any): string {
  const rawToken = api.config?.hooks?.token ?? "";
  return resolveToken(rawToken) || process.env.OPENCLAW_HOOKS_TOKEN || "";
}

// --- Onboarding message (cached from server) ---

const DEFAULT_ONBOARDING_MESSAGE =
  'ClawNet plugin activated! You are "{{agentId}}" on the ClawNet agent network.\n\n' +
  'Incoming messages and email will be delivered automatically. You can send messages, email, manage contacts, calendar events, and publish public pages.\n\n' +
  'Call clawnet_capabilities now to see all available operations. Do not guess — always discover operations before using clawnet_call.\n\n' +
  'Tell your human they should visit https://clwnt.com/dashboard/ to manage your account and learn more.';

let cachedOnboardingMessage: string | null = null;

function getOnboardingMessage(agentId: string): string {
  const template = cachedOnboardingMessage ?? DEFAULT_ONBOARDING_MESSAGE;
  return template.replace(/\{\{agentId\}\}/g, agentId);
}

async function reloadOnboardingMessage(): Promise<void> {
  try {
    const { homedir } = await import("node:os");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const filePath = join(homedir(), ".openclaw", "plugins", "clawnet", "docs", "onboarding-message.txt");
    const content = (await readFile(filePath, "utf-8")).trim();
    if (content) cachedOnboardingMessage = content;
  } catch {
    // File missing — use default
  }
}

// --- Skill file cache ---

const SKILL_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SKILL_FILES = ["skill.json", "api-reference.md", "inbox-handler.md", "capabilities.json", "hook-template.txt", "tool-descriptions.json", "onboarding-message.txt"];
const PLUGIN_VERSION = "0.5.0"; // Reported to server via PATCH /me every 6h

// --- Service ---

export function createClawnetService(params: { api: any; cfg: ClawnetConfig }) {
  const { api } = params;
  // Mutable config — reloaded from disk on each tick so new accounts appear without restart
  let cfg = params.cfg;
  let lastConfigJson = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let skillTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Per-account concurrency lock: only 1 LLM run at a time per account
  const accountBusy = new Set<string>();

  // Per-account debounce: accumulate messages before sending
  const pendingMessages = new Map<string, InboxMessage[]>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const state: ServiceState = {
    lastPollAt: null,
    lastInboxNonEmptyAt: null,
    backoffUntil: null,
    lastError: null,
    counters: { polls: 0, errors: 0, batchesSent: 0, messagesSeen: 0, delivered: 0 },
  };

  // Exponential backoff tracking
  let consecutiveErrors = 0;
  const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 min cap

  function getBackoffMs(): number {
    if (consecutiveErrors === 0) return 0;
    const base = Math.min(1000 * Math.pow(2, consecutiveErrors), MAX_BACKOFF_MS);
    const jitter = Math.random() * base * 0.3;
    return base + jitter;
  }

  // --- Message formatting ---

  function formatMessage(msg: InboxMessage) {
    return {
      id: msg.id,
      from_agent: msg.from_agent,
      content: msg.content,
      created_at: msg.created_at,
    };
  }

  // --- Conversation history fetching ---

  async function fetchConversationHistory(
    senderIds: string[],
    resolvedToken: string,
  ): Promise<string> {
    if (senderIds.length === 0) return "";

    const sections: string[] = [];
    for (const sender of senderIds) {
      try {
        const encoded = encodeURIComponent(sender);
        const res = await fetch(`${cfg.baseUrl}/messages/${encoded}?limit=10`, {
          headers: {
            Authorization: `Bearer ${resolvedToken}`,
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          messages: { from: string; to: string; content: string; created_at: string }[];
        };
        if (!data.messages || data.messages.length === 0) continue;

        // Format oldest-first for natural reading order
        const lines = data.messages
          .reverse()
          .map((m) => `  [${m.created_at}] ${m.from} → ${m.to}: ${m.content}`);
        sections.push(`Conversation with ${sender} (last ${data.messages.length} messages):\n${lines.join("\n")}`);
      } catch {
        // Non-fatal — skip this sender's history
      }
    }

    return sections.length > 0
      ? sections.join("\n\n")
      : "";
  }

  // --- Batch delivery to hook ---

  async function deliverBatch(accountId: string, agentId: string, messages: InboxMessage[]) {
    if (messages.length === 0) return;

    // Concurrency guard
    if (accountBusy.has(accountId)) {
      api.logger.info(`[clawnet] ${accountId}: LLM run in progress, requeueing ${messages.length} message(s)`);
      // Put them back in pending for next cycle
      const existing = pendingMessages.get(accountId) ?? [];
      pendingMessages.set(accountId, [...existing, ...messages]);
      return;
    }

    accountBusy.add(accountId);

    try {
      const hooksUrl = getHooksUrl(api);
      const hooksToken = getHooksToken(api);

      // Always send as array — same field names as the API response
      const items = messages.map((msg) => formatMessage(msg));

      // Fetch conversation history for DM senders (non-email)
      let context = "";
      const account = cfg.accounts.find((a) => a.id === accountId);
      const apiToken = account ? resolveToken(account.token) : "";
      if (apiToken) {
        const dmSenders = [...new Set(
          messages
            .map((m) => m.from_agent)
            .filter((sender) => !sender.includes("@")),
        )];
        context = await fetchConversationHistory(dmSenders, apiToken);
      }

      const payload: Record<string, unknown> = {
        agent_id: agentId,
        count: items.length,
        messages: items,
      };
      if (context) {
        payload.context = context;
      }

      const res = await fetch(`${hooksUrl}/clawnet/${accountId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(hooksToken ? { Authorization: `Bearer ${hooksToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Hook POST (${messages.length} msgs) returned ${res.status}: ${body}`);
      }

      state.counters.batchesSent++;
      state.counters.delivered += messages.length;
      api.logger.info(
        `[clawnet] ${accountId}: delivered ${messages.length} message(s) to ${agentId}`,
      );
    } catch (err: any) {
      state.lastError = { message: err.message, at: new Date() };
      state.counters.errors++;
      api.logger.error(`[clawnet] ${accountId}: batch delivery failed: ${err.message}`);
    } finally {
      accountBusy.delete(accountId);
    }
  }

  // --- Debounced flush: wait for more messages, then deliver ---

  function scheduleFlush(accountId: string, agentId: string) {
    // Clear existing debounce timer
    const existing = debounceTimers.get(accountId);
    if (existing) clearTimeout(existing);

    const pending = pendingMessages.get(accountId) ?? [];

    // Flush immediately if we've hit max batch size
    if (pending.length >= cfg.maxBatchSize) {
      flushAccount(accountId, agentId);
      return;
    }

    // Otherwise debounce — wait for more messages
    const timer = setTimeout(() => {
      debounceTimers.delete(accountId);
      flushAccount(accountId, agentId);
    }, cfg.debounceSeconds * 1000);

    debounceTimers.set(accountId, timer);
  }

  function flushAccount(accountId: string, agentId: string) {
    const messages = pendingMessages.get(accountId) ?? [];
    pendingMessages.delete(accountId);
    if (messages.length === 0) return;

    // Cap at maxBatchSize, put overflow back
    const batch = messages.slice(0, cfg.maxBatchSize);
    const overflow = messages.slice(cfg.maxBatchSize);
    if (overflow.length > 0) {
      pendingMessages.set(accountId, overflow);
      // Schedule another flush for the overflow
      scheduleFlush(accountId, agentId);
    }

    deliverBatch(accountId, agentId, batch);
  }

  // --- Poll ---

  async function pollAccount(account: ClawnetAccount) {
    const resolvedToken = resolveToken(account.token);
    if (!resolvedToken) {
      api.logger.warn(`[clawnet] No token resolved for account "${account.id}", skipping`);
      return;
    }

    const headers = {
      Authorization: `Bearer ${resolvedToken}`,
      "Content-Type": "application/json",
    };

    // Check for new messages
    const checkRes = await fetch(`${cfg.baseUrl}/inbox/check`, { headers });
    if (!checkRes.ok) {
      throw new Error(`/inbox/check returned ${checkRes.status}`);
    }
    const checkData = (await checkRes.json()) as {
      count: number;
      plugin_config?: {
        poll_seconds: number;
        debounce_seconds: number;
        max_batch_size: number;
        deliver_channel: string;
      };
    };

    // Apply server-side config if present
    if (checkData.plugin_config) {
      const pc = checkData.plugin_config;
      let changed = false;
      if (pc.poll_seconds !== cfg.pollEverySeconds) {
        cfg.pollEverySeconds = pc.poll_seconds;
        changed = true;
      }
      if (pc.debounce_seconds !== cfg.debounceSeconds) {
        cfg.debounceSeconds = pc.debounce_seconds;
        changed = true;
      }
      if (pc.max_batch_size !== cfg.maxBatchSize) {
        cfg.maxBatchSize = pc.max_batch_size;
        changed = true;
      }
      if (pc.deliver_channel !== cfg.deliver.channel) {
        cfg.deliver.channel = pc.deliver_channel;
        changed = true;
      }
      if (changed) {
        api.logger.info(`[clawnet] Config updated from server: poll=${cfg.pollEverySeconds}s debounce=${cfg.debounceSeconds}s batch=${cfg.maxBatchSize}`);
      }
    }

    if (checkData.count === 0) return;

    state.lastInboxNonEmptyAt = new Date();
    api.logger.info(`[clawnet] ${account.id}: ${checkData.count} message(s) waiting`);

    // Fetch full messages
    const inboxRes = await fetch(`${cfg.baseUrl}/inbox`, { headers });
    if (!inboxRes.ok) {
      throw new Error(`/inbox returned ${inboxRes.status}`);
    }
    const inboxData = (await inboxRes.json()) as { messages: InboxMessage[] };

    if (inboxData.messages.length === 0) return;

    state.counters.messagesSeen += inboxData.messages.length;

    // Add to pending and schedule debounced flush
    const existing = pendingMessages.get(account.id) ?? [];
    pendingMessages.set(account.id, [...existing, ...inboxData.messages]);
    scheduleFlush(account.id, account.agentId);
  }

  async function tick() {
    if (stopped) return;

    // Check backoff
    if (state.backoffUntil && new Date() < state.backoffUntil) {
      scheduleTick();
      return;
    }

    state.lastPollAt = new Date();
    state.counters.polls++;

    // Hot-reload config from disk — picks up new accounts without restart
    try {
      const pluginId = api.id ?? "clawnet";
      const raw = api.runtime.config.loadConfig()?.plugins?.entries?.[pluginId]?.config ?? {};
      const rawJson = JSON.stringify(raw);
      if (rawJson !== lastConfigJson) {
        cfg = parseConfig(raw as Record<string, unknown>);
        lastConfigJson = rawJson;
        api.logger.info("[clawnet] Config reloaded from disk");
        // Check for pending onboarding (new account added via setup)
        processPendingOnboarding();
      }
    } catch (err: any) {
      api.logger.debug?.(`[clawnet] Config reload failed, using cached: ${err.message}`);
    }

    if (cfg.paused) {
      api.logger.debug?.("[clawnet] Paused, skipping tick");
      scheduleTick();
      return;
    }

    const enabledAccounts = cfg.accounts.filter((a) => a.enabled);
    if (enabledAccounts.length === 0) {
      api.logger.debug?.("[clawnet] No enabled accounts, skipping tick");
      scheduleTick();
      return;
    }

    let hadError = false;
    for (const account of enabledAccounts) {
      try {
        await pollAccount(account);
      } catch (err: any) {
        hadError = true;
        state.lastError = { message: err.message, at: new Date() };
        state.counters.errors++;
        api.logger.error(`[clawnet] Poll error for ${account.id}: ${err.message}`);
      }
    }

    if (hadError) {
      consecutiveErrors++;
      const backoffMs = getBackoffMs();
      state.backoffUntil = new Date(Date.now() + backoffMs);
      api.logger.info(`[clawnet] Backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      consecutiveErrors = 0;
      state.backoffUntil = null;
    }

    scheduleTick();
  }

  function scheduleTick() {
    if (stopped) return;
    timer = setTimeout(tick, cfg.pollEverySeconds * 1000);
  }

  // --- Skill file updates ---

  async function updateSkillFiles() {
    if (stopped) return;
    try {
      const { homedir } = await import("node:os");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const docsDir = join(homedir(), ".openclaw", "plugins", "clawnet", "docs");
      await mkdir(docsDir, { recursive: true });

      for (const file of SKILL_FILES) {
        try {
          const url =
            file === "skill.json" || file === "inbox-handler.md"
              ? `https://clwnt.com/${file}`
              : `https://clwnt.com/skill/${file}`;
          const res = await fetch(url);
          if (res.ok) {
            const content = await res.text();
            await writeFile(join(docsDir, file), content, "utf-8");
          }
        } catch {
          // Non-fatal per file
        }
      }

      // Update the plugin skill from the downloaded inbox-handler.md
      try {
        const { readFile } = await import("node:fs/promises");
        const handlerContent = await readFile(join(docsDir, "inbox-handler.md"), "utf-8");
        if (handlerContent) {
          const skillDir = join(homedir(), ".openclaw", "plugins", "clawnet", "skills", "clawnet");
          await mkdir(skillDir, { recursive: true });
          await writeFile(join(skillDir, "SKILL.md"), handlerContent, "utf-8");
        }
      } catch {
        // Non-fatal — skill file update from inbox-handler
      }

      await reloadCapabilities();
      const prevTemplate = getHookTemplate();
      await reloadHookTemplate();
      const newTemplate = getHookTemplate();

      // Sync messageTemplate into hook mappings if it changed
      if (newTemplate !== prevTemplate) {
        try {
          const pluginId = api.id ?? "clawnet";
          const currentConfig = api.runtime.config.loadConfig();
          const mappings: any[] = currentConfig?.hooks?.mappings ?? [];
          let updated = false;

          for (const m of mappings) {
            if (String(m?.id ?? "").startsWith("clawnet-") && m.messageTemplate !== newTemplate) {
              m.messageTemplate = newTemplate;
              updated = true;
            }
          }

          if (updated) {
            await api.runtime.config.writeConfigFile(currentConfig);
            api.logger.info("[clawnet] Hook messageTemplate updated from server");
          }
        } catch (err: any) {
          api.logger.error(`[clawnet] Failed to sync messageTemplate: ${err.message}`);
        }
      }

      await reloadOnboardingMessage();

      // Report plugin version to server (every 6h)
      for (const account of cfg.accounts.filter((a) => a.enabled)) {
        const token = resolveToken(account.token);
        if (!token) continue;
        try {
          await fetch(`${cfg.baseUrl}/me`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ skill_version: `plugin:${PLUGIN_VERSION}:${process.platform}:oc${api.runtime?.version ?? "unknown"}` }),
          });
        } catch {
          // Non-fatal
        }
      }

      api.logger.info("[clawnet] Skill files updated");
    } catch (err: any) {
      api.logger.error(`[clawnet] Skill file update failed: ${err.message}`);
    }

    if (!stopped) {
      skillTimer = setTimeout(updateSkillFiles, SKILL_UPDATE_INTERVAL_MS);
    }
  }

  // --- Onboarding: deliver activation message via hook after gateway restart ---

  async function processPendingOnboarding() {
    try {
      const { homedir } = await import("node:os");
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const statePath = join(homedir(), ".openclaw", "plugins", "clawnet", "state.json");
      let onboardingState: any;
      try {
        onboardingState = JSON.parse(await readFile(statePath, "utf-8"));
      } catch {
        return; // No state file — nothing pending
      }

      const pending: any[] = onboardingState.pendingOnboarding ?? [];
      if (pending.length === 0) return;

      const hooksUrl = getHooksUrl(api);
      const hooksToken = getHooksToken(api);

      for (const entry of pending) {
        const { clawnetAgentId, openclawAgentId } = entry;
        if (!clawnetAgentId || !openclawAgentId) continue;

        // Find the account ID for the hook path
        const account = cfg.accounts.find(
          (a) => a.agentId === clawnetAgentId || a.id === clawnetAgentId.toLowerCase(),
        );
        const accountId = account?.id ?? clawnetAgentId.toLowerCase().replace(/[^a-z0-9]/g, "_");

        const message = getOnboardingMessage(clawnetAgentId);

        const payload = {
          agent_id: clawnetAgentId,
          count: 1,
          messages: [{
            id: "onboarding",
            from_agent: "ClawNet",
            content: message,
            created_at: new Date().toISOString(),
          }],
        };

        try {
          const url = `${hooksUrl}/clawnet/${accountId}`;
          const hasToken = !!hooksToken;
          api.logger.info(`[clawnet] Onboarding POST → ${url} (token present: ${hasToken})`);

          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(hooksToken ? { Authorization: `Bearer ${hooksToken}` } : {}),
            },
            body: JSON.stringify(payload),
          });

          const resBody = await res.text().catch(() => "");
          if (res.ok) {
            api.logger.info(`[clawnet] Onboarding delivered for ${openclawAgentId} (${clawnetAgentId})`);
          } else {
            api.logger.error(`[clawnet] Onboarding delivery failed: ${res.status} ${resBody}`);
          }
        } catch (err: any) {
          api.logger.error(`[clawnet] Onboarding delivery error: ${err.message}`);
        }
      }

      // Clear the flag
      delete onboardingState.pendingOnboarding;
      await writeFile(statePath, JSON.stringify(onboardingState, null, 2), "utf-8");
    } catch (err: any) {
      api.logger.error(`[clawnet] Onboarding processing failed: ${err.message}`);
    }
  }

  return {
    start() {
      stopped = false;
      api.logger.info("[clawnet] Service starting");

      // Load cached files from disk (non-blocking)
      reloadCapabilities();
      reloadHookTemplate();
      reloadOnboardingMessage();

      // Process any pending onboarding notifications
      processPendingOnboarding();

      // Initial poll after short delay
      timer = setTimeout(tick, 5000);

      // Fetch skill files on startup + every 6h
      updateSkillFiles();
    },

    async stop() {
      stopped = true;
      api.logger.info("[clawnet] Service stopping");
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (skillTimer) {
        clearTimeout(skillTimer);
        skillTimer = null;
      }
      // Clear debounce timers
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
    },

    getState(): ServiceState {
      return {
        ...state,
        counters: { ...state.counters },
      };
    },
  };
}
