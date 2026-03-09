import type { Command } from "commander";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawnetConfig } from "./config.js";

const API_BASE = "https://api.clwnt.com";
const DEVICE_POLL_INTERVAL_MS = 3000;
const DEVICE_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// --- Helpers ---

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptWithDefault(rl: readline.Interface, question: string, defaultVal: string): Promise<string> {
  const answer = await prompt(rl, `${question} [${defaultVal}]: `);
  return answer.trim() || defaultVal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Hook mapping builder (from spec) ---

const DEFAULT_HOOK_TEMPLATE =
  "You have {{count}} new ClawNet message(s).\n\n" +
  "Messages:\n{{messages}}\n\n" +
  "{{context}}";

let cachedHookTemplate: string | null = null;

export async function reloadHookTemplate(): Promise<void> {
  try {
    const templatePath = path.join(os.homedir(), ".openclaw", "plugins", "clawnet", "docs", "hook-template.txt");
    const content = (await fs.readFile(templatePath, "utf-8")).trim();
    if (content) cachedHookTemplate = content;
  } catch {
    // File missing — use default
  }
}

export function getHookTemplate(): string {
  return cachedHookTemplate ?? DEFAULT_HOOK_TEMPLATE;
}

export interface DeliveryTarget {
  channel: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string;
}

export function buildClawnetMapping(accountId: string, channel: string, openclawAgentId: string, delivery?: DeliveryTarget) {
  const mapping: Record<string, any> = {
    id: `clawnet-${accountId}`,
    match: { path: `clawnet/${accountId}` },
    action: "agent",
    wakeMode: "now",
    name: "ClawNet",
    agentId: openclawAgentId,
    sessionKey: `hook:clawnet:${accountId}:inbox`,
    messageTemplate: getHookTemplate(),
    deliver: true,
    channel: delivery?.channel ?? channel,
  };

  // Explicit delivery target fields (set by /clawnet link)
  if (delivery?.to) mapping.to = delivery.to;
  if (delivery?.accountId) mapping.accountId = delivery.accountId;
  if (delivery?.messageThreadId) mapping.messageThreadId = delivery.messageThreadId;

  return mapping;
}

export function upsertMapping(mappings: any[], owned: any): any[] {
  const id = String(owned.id ?? "").trim();
  const idx = mappings.findIndex((m: any) => String(m?.id ?? "").trim() === id);
  if (idx >= 0) {
    const next = mappings.slice();
    next[idx] = owned;
    return next;
  }
  return [...mappings, owned];
}

function ensurePrefix(list: string[] | undefined, prefix: string): string[] {
  const set = new Set((list ?? []).map((x: string) => String(x).trim()).filter(Boolean));
  set.add(prefix);
  return Array.from(set).sort();
}

// --- .env file helpers ---

async function readEnvFile(envPath: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  try {
    const content = await fs.readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        entries.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
      }
    }
  } catch {
    // File doesn't exist yet
  }
  return entries;
}

async function writeEnvFile(envPath: string, entries: Map<string, string>) {
  const lines: string[] = [];
  for (const [key, val] of entries) {
    lines.push(`${key}=${val}`);
  }
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");
}

// --- Token file helper ---

async function writeTokenFile(agentId: string, token: string) {
  const tokenDir = path.join(os.homedir(), ".openclaw", "plugins", "clawnet", agentId);
  await fs.mkdir(tokenDir, { recursive: true });
  await fs.writeFile(path.join(tokenDir, ".token"), token, { mode: 0o600 });
}

// --- Shared status builder (used by CLI and /clawnet status command) ---

export function buildStatusText(api: any): string {
  let currentConfig: any;
  try {
    currentConfig = api.runtime.config.loadConfig();
  } catch {
    return "Could not load OpenClaw config.";
  }

  const pluginEntry = currentConfig?.plugins?.entries?.clawnet;
  const pluginCfg = pluginEntry?.config;
  const hooks = currentConfig?.hooks;
  const lines: string[] = [];

  lines.push("**ClawNet Status**\n");

  lines.push(`Plugin enabled: ${pluginEntry?.enabled ?? false}`);
  if (pluginCfg) {
    if (pluginCfg.paused) {
      lines.push("Polling: **PAUSED** (run /clawnet resume to restart)");
    }
    lines.push(`Poll interval: ${pluginCfg.pollEverySeconds ?? "?"}s`);

    const accounts: any[] = pluginCfg.accounts ?? [];
    const agentList: any[] = currentConfig?.agents?.list ?? [];
    const openclawAgentIds = agentList
      .map((a: any) => (typeof a?.id === "string" ? a.id.trim() : ""))
      .filter(Boolean);
    const defaultAgent = currentConfig?.defaultAgentId ?? "main";
    if (!openclawAgentIds.includes(defaultAgent)) {
      openclawAgentIds.unshift(defaultAgent);
    }

    lines.push("\nAccounts:");
    for (const oid of openclawAgentIds) {
      const account = accounts.find((a: any) => (a.openclawAgentId ?? a.id) === oid);
      if (account) {
        const status = account.enabled !== false ? "enabled" : "disabled";
        lines.push(`  ${account.agentId} -> ${oid} (${status})`);
      } else {
        lines.push(`  ${oid} -> not configured`);
      }
    }
    for (const account of accounts) {
      const target = account.openclawAgentId ?? account.id;
      if (!openclawAgentIds.includes(target)) {
        const status = account.enabled !== false ? "enabled" : "disabled";
        lines.push(`  ${account.agentId} -> ${target} (${status}, orphaned)`);
      }
    }
  } else {
    lines.push("Config: Not configured (run `openclaw clawnet setup`)");
  }

  lines.push(`\nHooks enabled: ${hooks?.enabled ?? false}`);
  lines.push(`Hooks token: ${hooks?.token ? "set" : "MISSING"}`);

  const clawnetMappings = (hooks?.mappings ?? []).filter(
    (m: any) => String(m?.id ?? "").startsWith("clawnet-"),
  );
  if (clawnetMappings.length > 0) {
    lines.push(`Mappings: ${clawnetMappings.length} clawnet mapping(s)`);
    for (const m of clawnetMappings) {
      const channel = m.channel ?? "?";
      const isPinned = channel !== "last" && m.to;
      if (isPinned) {
        lines.push(`  ${m.id}: pinned to ${channel} (${m.to}) — set via /clawnet link`);
      } else {
        lines.push(`  ${m.id}: auto (channel:last)`);
      }
    }
  } else {
    lines.push("Mappings: NONE");
  }

  // Warnings
  const warnings: string[] = [];
  if (!hooks?.enabled) warnings.push("hooks.enabled is false");
  if (!hooks?.token) warnings.push("hooks.token is missing");
  if (clawnetMappings.length === 0) warnings.push("No clawnet hook mappings found");
  const prefixes: string[] = hooks?.allowedSessionKeyPrefixes ?? [];
  if (!prefixes.includes("hook:")) {
    warnings.push('hooks.allowedSessionKeyPrefixes is missing "hook:"');
  }

  if (warnings.length > 0) {
    lines.push("\nWarnings:");
    for (const w of warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join("\n");
}

// --- CLI registration ---

export function registerClawnetCli(params: { program: Command; api: any; cfg: ClawnetConfig }) {
  const { program, api } = params;
  const root = program.command("clawnet").description("ClawNet integration");

  // --- setup ---
  root
    .command("setup")
    .description("Connect a ClawNet agent to this OpenClaw instance")
    .action(async () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log("\n  ClawNet Setup\n");

        // Load current config to show existing accounts
        let currentConfig: any;
        try {
          currentConfig = api.runtime.config.loadConfig();
        } catch {
          currentConfig = {};
        }
        const pluginConfig = currentConfig?.plugins?.entries?.clawnet?.config ?? {};
        const existingAccounts: any[] = pluginConfig.accounts ?? [];

        // Build list of OpenClaw agents
        const agentList: any[] = currentConfig?.agents?.list ?? [];
        const openclawAgentIds = agentList
          .map((a: any) => (typeof a?.id === "string" ? a.id.trim() : ""))
          .filter(Boolean);
        const defaultAgent = currentConfig?.defaultAgentId ?? "main";
        if (!openclawAgentIds.includes(defaultAgent)) {
          openclawAgentIds.unshift(defaultAgent);
        }

        // Show agent status
        console.log("  Available agents:");
        const agentStatus = openclawAgentIds.map((id: string) => {
          const account = existingAccounts.find((a: any) => (a.openclawAgentId ?? a.id) === id);
          return { openclawId: id, account };
        });

        agentStatus.forEach(({ openclawId, account }, i: number) => {
          const linked = account
            ? `linked as ${account.agentId} (${account.enabled !== false ? "enabled" : "disabled"})`
            : "(not configured)";
          const isDefault = openclawId === defaultAgent ? " (default)" : "";
          console.log(`    ${i + 1}. ${openclawId}${isDefault}  ${linked}`);
        });
        console.log("");

        // Pick which agent to configure — auto-select if only one
        let targetAgent: string;
        if (openclawAgentIds.length === 1) {
          targetAgent = openclawAgentIds[0];
          console.log(`  Configuring ${targetAgent}...\n`);
        } else {
          const choice = await prompt(rl, "  Select an agent to configure: ");
          const trimmed = choice.trim();
          const num = parseInt(trimmed, 10);
          if (num >= 1 && num <= openclawAgentIds.length) {
            targetAgent = openclawAgentIds[num - 1];
          } else if (openclawAgentIds.includes(trimmed)) {
            targetAgent = trimmed;
          } else {
            console.log(`  Unknown agent "${trimmed}".`);
            return;
          }
        }

        // Check if already configured
        const existingAccount = existingAccounts.find((a: any) => (a.openclawAgentId ?? a.id) === targetAgent);
        if (existingAccount) {
          const reconfig = await prompt(
            rl,
            `  ${targetAgent} is linked as ${existingAccount.agentId}. Reconfigure? (y/N): `,
          );
          if (reconfig.trim().toLowerCase() !== "y") {
            console.log("  Skipped.\n");
            return;
          }
        }

        // Step 1: Get device code
        console.log("\n  Requesting link code...\n");
        const codeRes = await fetch(`${API_BASE}/auth/device-code`, { method: "POST" });
        if (!codeRes.ok) {
          console.error("  Failed to get device code. Is the ClawNet API reachable?");
          return;
        }
        const codeData = (await codeRes.json()) as {
          code: string;
          device_secret: string;
          expires_at: string;
        };

        // Step 2: Display setup URL and wait
        const setupUrl = `https://clwnt.com/setup?code=${codeData.code}`;
        console.log(`  Open this link to connect:\n`);
        console.log(`  ${setupUrl}\n`);
        console.log(`  Code expires at ${new Date(codeData.expires_at).toLocaleTimeString()}.\n`);
        console.log("  Waiting for link...");

        // Step 3: Poll for completion
        const startTime = Date.now();
        let linked = false;
        let agentId = "";
        let token = "";

        while (Date.now() - startTime < DEVICE_POLL_TIMEOUT_MS) {
          await sleep(DEVICE_POLL_INTERVAL_MS);

          const pollRes = await fetch(
            `${API_BASE}/auth/device-poll?secret=${codeData.device_secret}`,
          );
          if (!pollRes.ok) {
            const pollData = (await pollRes.json()) as { error: string };
            if (pollData.error === "expired") {
              console.error("\n  Code expired. Run `openclaw clawnet setup` again.");
              return;
            }
            continue;
          }

          const pollData = (await pollRes.json()) as {
            status: string;
            agent_id?: string;
            token?: string;
          };

          if (pollData.status === "linked" && pollData.agent_id && pollData.token) {
            linked = true;
            agentId = pollData.agent_id;
            token = pollData.token;
            break;
          }
        }

        if (!linked) {
          console.error("\n  Timed out waiting for link. Run `openclaw clawnet setup` again.");
          return;
        }

        console.log(`\n  Linked to ${agentId}!\n`);

        // Defaults — user can change via dashboard
        const channel = "last";

        // Determine account ID (lowercase, safe for env var names)
        const accountId = agentId.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const envVarName = `CLAWNET_TOKEN_${accountId.toUpperCase()}`;

        // Step 4: Write token files
        console.log("  Writing configuration...\n");

        // Write token to .env
        const envPath = path.join(os.homedir(), ".openclaw", ".env");
        const envEntries = await readEnvFile(envPath);
        envEntries.set(envVarName, token);

        // Ensure hooks token exists
        let hooksTokenGenerated = false;
        if (!envEntries.has("OPENCLAW_HOOKS_TOKEN")) {
          envEntries.set("OPENCLAW_HOOKS_TOKEN", crypto.randomBytes(32).toString("hex"));
          hooksTokenGenerated = true;
        }

        await writeEnvFile(envPath, envEntries);

        // Write per-agent token file (for LLM curl commands in hook turns)
        await writeTokenFile(agentId, token);

        // Step 5: Update OpenClaw config
        try {
          const freshConfig = api.runtime.config.loadConfig();
          const cfg = structuredClone(freshConfig);

          // Plugin config
          cfg.plugins ??= {};
          cfg.plugins.entries ??= {};
          cfg.plugins.entries.clawnet ??= {};
          cfg.plugins.entries.clawnet.enabled = true;
          const pc = cfg.plugins.entries.clawnet.config ?? {};

          pc.baseUrl = API_BASE;
          pc.pollEverySeconds = pc.pollEverySeconds ?? 120;
          pc.debounceSeconds = pc.debounceSeconds ?? 30;
          pc.maxBatchSize = pc.maxBatchSize ?? 10;
          pc.deliver = pc.deliver ?? { channel };
          pc.maxSnippetChars = 500;
          pc.setupVersion = 1;
          pc.lastAppliedAt = new Date().toISOString();

          // Upsert account
          const accounts: any[] = pc.accounts ?? [];
          const existingIdx = accounts.findIndex((a: any) => a.agentId === agentId || a.openclawAgentId === targetAgent);
          const newAccount = {
            id: accountId,
            token: `\${${envVarName}}`,
            agentId,
            openclawAgentId: targetAgent,
            enabled: true,
          };
          if (existingIdx >= 0) {
            accounts[existingIdx] = newAccount;
          } else {
            accounts.push(newAccount);
          }
          pc.accounts = accounts;
          cfg.plugins.entries.clawnet.config = pc;

          // Hooks config
          cfg.hooks ??= {};
          cfg.hooks.enabled = true;

          // hooks.token — only set if missing
          if (!cfg.hooks.token) {
            cfg.hooks.token = "${OPENCLAW_HOOKS_TOKEN}";
          }

          // allowedSessionKeyPrefixes — ensure "hook:" is present
          cfg.hooks.allowedSessionKeyPrefixes = ensurePrefix(
            cfg.hooks.allowedSessionKeyPrefixes,
            "hook:",
          );

          // Upsert per-account clawnet mapping
          let mappings = cfg.hooks.mappings ?? [];
          mappings = upsertMapping(mappings, buildClawnetMapping(accountId, channel, targetAgent));
          cfg.hooks.mappings = mappings;

          // allowedAgentIds — ensure target agent is included
          if (!cfg.hooks.allowedAgentIds) {
            cfg.hooks.allowedAgentIds = openclawAgentIds;
          } else {
            const existing = new Set(cfg.hooks.allowedAgentIds);
            existing.add(targetAgent);
            cfg.hooks.allowedAgentIds = Array.from(existing);
          }

          // Enable clawnet tools globally (additive to existing profile)
          if (!cfg.tools) cfg.tools = {};
          if (!cfg.tools.alsoAllow) cfg.tools.alsoAllow = [];
          if (!cfg.tools.alsoAllow.includes("clawnet")) {
            cfg.tools.alsoAllow.push("clawnet");
          }

          // Enable optional (side-effect) tools for the target agent
          if (!cfg.agents) cfg.agents = {};
          if (!cfg.agents.list) cfg.agents.list = [];
          let agentEntry = cfg.agents.list.find((a: any) => a.id === targetAgent);
          if (!agentEntry) {
            agentEntry = { id: targetAgent, tools: { allow: ["clawnet"] } };
            cfg.agents.list.push(agentEntry);
          } else {
            if (!agentEntry.tools) agentEntry.tools = {};
            if (!agentEntry.tools.allow) agentEntry.tools.allow = [];
            if (!agentEntry.tools.allow.includes("clawnet")) {
              agentEntry.tools.allow.push("clawnet");
            }
          }

          // Set dmScope to "main" for single-owner setups (enables channel:"last" for hooks)
          if (!cfg.session) cfg.session = {};
          if (cfg.session.dmScope !== "main") {
            cfg.session.dmScope = "main";
            console.log("  Set session.dmScope = main (single-owner mode for cross-surface delivery)");
          }

          cfg.plugins.entries.clawnet.config = pc;

          await api.runtime.config.writeConfigFile(cfg);

          // Queue onboarding notification via state file (survives gateway restart)
          try {
            const stateDir = path.join(os.homedir(), ".openclaw", "plugins", "clawnet");
            await fs.mkdir(stateDir, { recursive: true });
            const statePath = path.join(stateDir, "state.json");
            let state: any = {};
            try {
              state = JSON.parse(await fs.readFile(statePath, "utf-8"));
            } catch {
              // No state file yet
            }
            const pending: any[] = state.pendingOnboarding ?? [];
            const pendingEntry = pending.find((p: any) => p.openclawAgentId === targetAgent);
            if (!pendingEntry) {
              pending.push({ clawnetAgentId: agentId, openclawAgentId: targetAgent });
            } else {
              pendingEntry.clawnetAgentId = agentId;
            }
            state.pendingOnboarding = pending;
            await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
            console.log(`  Onboarding queued: ${statePath}`);
          } catch (stateErr: any) {
            console.error(`  State file write failed: ${stateErr.message}`);
          }
        } catch (err: any) {
          console.error(`\n  Failed to write OpenClaw config: ${err.message}`);
          console.error("  You may need to configure hooks manually. Run 'openclaw clawnet status' for details.");
        }

        // Step 6: Summary
        console.log("  Done! Here's what was configured:\n");
        console.log(`    ClawNet agent:  ${agentId}`);
        console.log(`    OpenClaw agent: ${targetAgent}`);
        console.log(`    Token stored:   ~/.openclaw/.env (as ${envVarName})`);
        if (hooksTokenGenerated) {
          console.log("    Hooks token:    Generated (OPENCLAW_HOOKS_TOKEN)");
        }
        console.log(`    Hook mapping:   clawnet-${accountId} -> clawnet/${accountId}`);
        console.log("");
        console.log("  Change settings anytime at: https://clwnt.com/dashboard/");
        console.log("");
        console.log("  >>> Your agent will start receiving messages within a few minutes.\n");
      } finally {
        rl.close();
      }
    });

  // --- status ---
  root
    .command("status")
    .option("--probe", "Test connectivity to ClawNet API")
    .description("Show ClawNet plugin status")
    .action(async (opts) => {
      // Static config checks
      let currentConfig: any;
      try {
        currentConfig = api.runtime.config.loadConfig();
      } catch {
        console.log("  Could not load OpenClaw config.");
        return;
      }

      const pluginEntry = currentConfig?.plugins?.entries?.clawnet;
      const pluginCfg = pluginEntry?.config;
      const hooks = currentConfig?.hooks;

      console.log("\n  ClawNet Status\n");

      // Plugin
      console.log(`  Plugin enabled:   ${pluginEntry?.enabled ?? false}`);
      if (pluginCfg) {
        console.log(`  Poll interval:    ${pluginCfg.pollEverySeconds ?? "?"}s`);
        console.log(`  Setup version:    ${pluginCfg.setupVersion ?? 0}`);

        // Per-agent account details
        const accounts: any[] = pluginCfg.accounts ?? [];
        const agentList: any[] = currentConfig?.agents?.list ?? [];
        const openclawAgentIds = agentList
          .map((a: any) => (typeof a?.id === "string" ? a.id.trim() : ""))
          .filter(Boolean);
        const defaultAgent = currentConfig?.defaultAgentId ?? "main";
        if (!openclawAgentIds.includes(defaultAgent)) {
          openclawAgentIds.unshift(defaultAgent);
        }

        console.log("");
        console.log("  Accounts:");
        for (const oid of openclawAgentIds) {
          const account = accounts.find((a: any) => (a.openclawAgentId ?? a.id) === oid);
          if (account) {
            const status = account.enabled !== false ? "enabled" : "disabled";
            console.log(`    ${account.agentId} -> ${oid} (${status})`);
          } else {
            console.log(`    ${oid} -> not configured`);
          }
        }
        // Show accounts linked to agents not in the list
        for (const account of accounts) {
          const target = account.openclawAgentId ?? account.id;
          if (!openclawAgentIds.includes(target)) {
            const status = account.enabled !== false ? "enabled" : "disabled";
            console.log(`    ${account.agentId} -> ${target} (${status}, orphaned)`);
          }
        }
      } else {
        console.log("  Config:           Not configured (run `openclaw clawnet setup`)");
      }

      // Hooks
      console.log("");
      console.log(`  Hooks enabled:    ${hooks?.enabled ?? false}`);
      console.log(`  Hooks token:      ${hooks?.token ? "set" : "MISSING"}`);
      const clawnetMappings = (hooks?.mappings ?? []).filter(
        (m: any) => String(m?.id ?? "").startsWith("clawnet-"),
      );
      if (clawnetMappings.length > 0) {
        console.log(`  Mappings:         ${clawnetMappings.length} clawnet mapping(s)`);
        for (const m of clawnetMappings) {
          console.log(`    ${m.id} -> ${m.match?.path ?? "?"} (agent: ${m.agentId})`);
        }
      } else {
        console.log("  Mappings:         NONE");
      }

      // Warnings
      const warnings: string[] = [];
      if (!hooks?.enabled) warnings.push("hooks.enabled is false");
      if (!hooks?.token) warnings.push("hooks.token is missing");
      if (clawnetMappings.length === 0) warnings.push("No clawnet hook mappings found");
      const prefixes: string[] = hooks?.allowedSessionKeyPrefixes ?? [];
      if (!prefixes.includes("hook:")) {
        warnings.push('hooks.allowedSessionKeyPrefixes is missing "hook:"');
      }

      if (warnings.length > 0) {
        console.log("\n  Warnings:");
        for (const w of warnings) {
          console.log(`    - ${w}`);
        }
      }

      // Optional connectivity probe
      if (opts.probe && pluginCfg?.accounts) {
        console.log("\n  Connectivity:\n");
        for (const account of pluginCfg.accounts) {
          const tokenRef = account.token;
          const match = tokenRef.match(/^\$\{(.+)\}$/);
          const resolvedToken = match ? process.env[match[1]] || "" : tokenRef;

          if (!resolvedToken) {
            console.log(`    ${account.id}: NO TOKEN (env var not set)`);
            continue;
          }

          try {
            const res = await fetch(`${pluginCfg.baseUrl}/inbox/check`, {
              headers: { Authorization: `Bearer ${resolvedToken}` },
            });
            if (res.ok) {
              const data = (await res.json()) as { count: number };
              console.log(`    ${account.id}: OK (${data.count} pending)`);
            } else if (res.status === 401) {
              console.log(`    ${account.id}: UNAUTHORIZED (bad token)`);
            } else {
              console.log(`    ${account.id}: ERROR (${res.status})`);
            }
          } catch (err: any) {
            console.log(`    ${account.id}: UNREACHABLE (${err.message})`);
          }
        }
      }

      console.log("");
    });

  // --- uninstall ---
  root
    .command("uninstall")
    .option("--purge", "Remove config entirely (default: just disable)")
    .description("Disable ClawNet plugin and remove hook mapping")
    .action(async (opts) => {
      const currentConfig = api.runtime.config.loadConfig();
      const cfg = { ...currentConfig };

      // Disable plugin (keep config for easy re-enable unless --purge)
      if (cfg.plugins?.entries?.clawnet) {
        cfg.plugins.entries.clawnet.enabled = false;
        if (opts.purge) {
          delete cfg.plugins.entries.clawnet.config;
        }
      }

      // Remove all clawnet mappings (clawnet-* ids + legacy "clawnet")
      const beforeCount = cfg.hooks?.mappings?.length ?? 0;
      if (cfg.hooks?.mappings) {
        cfg.hooks.mappings = cfg.hooks.mappings.filter(
          (m: any) => {
            const id = String(m?.id ?? "");
            return id !== "clawnet" && !id.startsWith("clawnet-");
          },
        );
      }
      const removedCount = beforeCount - (cfg.hooks?.mappings?.length ?? 0);

      console.log("\n  ClawNet uninstalled.\n");
      console.log("  - Plugin disabled");
      if (removedCount > 0) {
        console.log(`  - ${removedCount} hook mapping(s) removed`);
      }

      // Do NOT touch: hooks.enabled, hooks.token, allowedSessionKeyPrefixes, allowedAgentIds

      await api.runtime.config.writeConfigFile(cfg);

      console.log("  - hooks.enabled, hooks.token left untouched");
      if (opts.purge) {
        console.log("  - Plugin config purged");
      }
      console.log("\n  Restart the Gateway to apply: openclaw gateway restart\n");
    });
}
