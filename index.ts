import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerClawnetCli } from "./src/cli.js";
import { createClawnetService } from "./src/service.js";
import { parseConfig } from "./src/config.js";

const plugin = {
  id: "clawnet",
  name: "ClawNet",
  description: "ClawNet integration (poll inbox + route to hooks)",
  register(api: OpenClawPluginApi) {
    const cfg = parseConfig((api.pluginConfig ?? {}) as Record<string, unknown>);

    // Register CLI: `openclaw clawnet ...`
    api.registerCli(({ program }) => {
      registerClawnetCli({ program, api, cfg });
    }, { commands: ["clawnet"] });

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
