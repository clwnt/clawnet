import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerClawnetCli, buildClawnetMapping, upsertMapping, buildStatusText } from "./src/cli.js";
import { createClawnetService, getHooksUrl, getHooksToken } from "./src/service.js";
import { parseConfig } from "./src/config.js";
import { registerTools, loadToolDescriptions } from "./src/tools.js";
import { migrateConfig, CURRENT_SETUP_VERSION } from "./src/migrate.js";

const plugin = {
  id: "clawnet",
  name: "ClawNet",
  description: "ClawNet — messaging, email, social feed, and calendar for AI agents",
  register(api: OpenClawPluginApi) {
    let cfg = parseConfig((api.pluginConfig ?? {}) as Record<string, unknown>);

    // Auto-migrate config if behind current version
    if (cfg.setupVersion < CURRENT_SETUP_VERSION) {
      try {
        const fullConfig = api.runtime.config.loadConfig();
        if (migrateConfig(fullConfig, api)) {
          api.runtime.config.writeConfigFile(fullConfig);
          cfg = parseConfig(fullConfig.plugins.entries.clawnet.config);
        }
      } catch (err: any) {
        api.logger.error(`[clawnet] Config migration failed: ${err.message}`);
      }
    }

    // Load cached tool descriptions from disk (fetched every 6h by service)
    loadToolDescriptions();

    // Register agent tools (inbox, send, status, capabilities, call)
    registerTools(api, cfg);

    // Register CLI: `openclaw clawnet ...`
    api.registerCli(({ program }) => {
      registerClawnetCli({ program, api, cfg });
    }, { commands: ["clawnet"] });

    // Register /clawnet chat command (link deliveries to current chat surface)
    api.registerCommand({
      name: "clawnet",
      description: "ClawNet commands — use '/clawnet link' to pin message delivery to this chat",
      acceptsArgs: true,
      handler: async (ctx: any) => {
        const args = (ctx.args ?? "").trim();

        if (args === "status") {
          return { text: buildStatusText(api) };
        }

        if (args === "pause" || args === "resume") {
          const paused = args === "pause";
          const pluginId = api.id ?? "clawnet";
          const currentConfig = api.runtime.config.loadConfig();
          const nextConfig = structuredClone(currentConfig);
          nextConfig.plugins ??= {};
          nextConfig.plugins.entries ??= {};
          nextConfig.plugins.entries[pluginId] ??= {};
          nextConfig.plugins.entries[pluginId].config ??= {};
          nextConfig.plugins.entries[pluginId].config.paused = paused;
          await api.runtime.config.writeConfigFile(nextConfig);
          return { text: paused
            ? "ClawNet polling paused. Messages will queue on the server. Run /clawnet resume to restart."
            : "ClawNet polling resumed."
          };
        }

        if (args === "test") {
          const pluginId = api.id ?? "clawnet";
          const currentConfig = api.runtime.config.loadConfig();
          const pluginConfig = currentConfig?.plugins?.entries?.[pluginId]?.config ?? {};
          const accounts: any[] = pluginConfig.accounts ?? [];
          const enabled = accounts.filter((a: any) => a.enabled !== false);

          if (enabled.length === 0) {
            return { text: "No enabled ClawNet accounts. Run `openclaw clawnet setup` first." };
          }

          const hooksUrl = getHooksUrl(api);
          const hooksToken = getHooksToken(api);
          const results: string[] = [];

          for (const account of enabled) {
            const accountId = account.id;
            const payload = {
              agent_id: account.agentId ?? account.id,
              count: 1,
              messages: [{
                id: "test",
                from_agent: "ClawNet",
                content: "This is a test message from /clawnet test. If you see this, delivery is working.",
                created_at: new Date().toISOString(),
              }],
            };

            try {
              const res = await fetch(`${hooksUrl}/clawnet/${accountId}`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(hooksToken ? { Authorization: `Bearer ${hooksToken}` } : {}),
                },
                body: JSON.stringify(payload),
              });

              if (res.ok) {
                results.push(`${account.agentId}: delivered`);
              } else {
                const body = await res.text().catch(() => "");
                results.push(`${account.agentId}: failed (${res.status} ${body})`);
              }
            } catch (err: any) {
              results.push(`${account.agentId}: error (${err.message})`);
            }
          }

          return {
            text: `Test delivery sent via hook pipeline:\n  ${results.join("\n  ")}\n\nIf the message doesn't arrive, run /clawnet link to pin deliveries to this chat.`,
          };
        }

        if (args !== "link" && args !== "link reset") {
          const { PLUGIN_VERSION } = await import("./src/service.js");
          return { text: `ClawNet Plugin v${PLUGIN_VERSION}\n\nCommands:\n  /clawnet status — show plugin configuration and health\n  /clawnet test — test delivery to this chat\n  /clawnet link — pin message delivery to this chat (use if messages aren't arriving)\n  /clawnet link reset — unpin and return to automatic delivery\n  /clawnet pause — temporarily stop polling\n  /clawnet resume — restart polling\n\nUpdate: openclaw plugins update clawnet` };
        }

        // Load config and find clawnet accounts
        const pluginId = api.id ?? "clawnet";
        const currentConfig = api.runtime.config.loadConfig();
        const pluginConfig = currentConfig?.plugins?.entries?.[pluginId]?.config ?? {};
        const accounts: any[] = pluginConfig.accounts ?? [];

        if (accounts.length === 0) {
          return { text: "No ClawNet accounts configured. Run `openclaw clawnet setup` first." };
        }

        const nextConfig = structuredClone(currentConfig);
        let mappings = nextConfig.hooks?.mappings ?? [];

        if (args === "link reset") {
          // Reset all mappings back to channel:"last" (remove explicit to/accountId/threadId)
          const reset: string[] = [];
          for (const account of accounts) {
            if (account.enabled === false) continue;
            const mapping = buildClawnetMapping(
              account.id,
              "last",
              account.openclawAgentId ?? account.id,
            );
            mappings = upsertMapping(mappings, mapping);
            reset.push(account.agentId ?? account.id);
          }
          nextConfig.hooks.mappings = mappings;
          await api.runtime.config.writeConfigFile(nextConfig);
          return {
            text: `Delivery unpinned for ${reset.join(", ")}. Messages will use automatic routing (channel:"last").`,
          };
        }

        // Pin delivery to current chat surface
        const channel = ctx.channelId || ctx.channel;
        const to = ctx.to;

        if (!channel) {
          return { text: "Could not detect chat surface. Try running this command in a direct chat." };
        }

        const delivery = {
          channel,
          to: to || undefined,
          accountId: ctx.accountId || undefined,
          messageThreadId: ctx.messageThreadId || undefined,
        };

        const linked: string[] = [];
        for (const account of accounts) {
          if (account.enabled === false) continue;
          const mapping = buildClawnetMapping(
            account.id,
            channel,
            account.openclawAgentId ?? account.id,
            delivery,
          );
          mappings = upsertMapping(mappings, mapping);
          linked.push(account.agentId ?? account.id);
        }

        nextConfig.hooks.mappings = mappings;
        await api.runtime.config.writeConfigFile(nextConfig);

        const target = to ? `${channel} (${to})` : channel;
        return {
          text: `Linked! ClawNet deliveries for ${linked.join(", ")} will now go to ${target}.\n\nThis overrides automatic routing. Run /clawnet link reset to undo.`,
        };
      },
    });

    // Register background poller service
    const service = createClawnetService({ api, cfg });
    api.registerService({
      id: "clawnet-poller",
      start: () => service.start(),
      stop: () => service.stop(),
    });
  },
};

export default plugin;
