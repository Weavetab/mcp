const fs = require('fs');
const file = 'c:/Users/fy2ne/Music/Weavetab/MCP/src/server.ts';
let code = fs.readFileSync(file, 'utf-8');

const startStr = '// ── Plugins Lifecycle (Add / Override / Remove) ───────────────────────────';
const endStr = 'let transport;';

const startIndex = code.indexOf(startStr);
const endIndex = code.indexOf(endStr);

if (startIndex === -1 || endIndex === -1) {
    console.error('Markers not found!');
    process.exit(1);
}

const newLogic = `// ── Plugins Lifecycle & Dynamic Registry ───────────────────────────
  const { getVerifiedPackages, resolvePluginTrust } = await import("./plugin/registry.js");
  const verifiedPackages = await getVerifiedPackages();

  const loadedPluginNames = new Set<string>();

  const registerPluginTools = async (plugin: WeavetabPlugin) => {
    if (loadedPluginNames.has(plugin.name)) return;
    
    const trust = resolvePluginTrust(plugin.name, verifiedPackages);
    const isOfficial = trust.tier === "official";

    const addedNames: string[] = [];
    const overriddenNames: string[] = [];
    const removedNames: string[] = [];

    // 1. Tool Removals (disable built-in tools)
    const toRemove = [
      ...(plugin.removeTools || []),
      ...(plugin.manifest?.permissions?.tools?.remove || []),
    ];
    for (const toolName of toRemove) {
      if ((server as any)._registeredTools?.[toolName]) {
        delete (server as any)._registeredTools[toolName];
        removedNames.push(toolName);
      }
    }

    // 2. Tool Overrides (replace or wrap built-in tools)
    const overrides = plugin.overrides || [];
    for (const ov of overrides) {
      const existingTool = (server as any)._registeredTools?.[ov.name];
      const existingDesc = existingTool?.description || "";
      const existingSchema = existingTool?.parameters?.shape || {};

      if (existingTool) {
        delete (server as any)._registeredTools[ov.name];
      }

      server.tool(
        ov.name,
        ov.description || existingDesc || \`Tool overridden by \${plugin.name}\`,
        ov.schema || existingSchema,
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              ov.name,
              async (session, liveConfig) => {
                const wrappedOrig = existingTool
                  ? async (origArgs: Record<string, any>, _sess: any, _cfg: any) => {
                      const res = await existingTool.handler(origArgs, {});
                      return res;
                    }
                  : undefined;

                const result = await ov.handler(args, session, liveConfig, wrappedOrig);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              },
              isOfficial
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      overriddenNames.push(ov.name);
    }

    // 3. Tool Additions (new tools)
    const newTools = plugin.tools || [];
    for (const td of newTools) {
      if ((server as any)._registeredTools?.[td.name]) {
        delete (server as any)._registeredTools[td.name];
      }
      server.tool(
        td.name,
        td.description,
        td.schema,
        async (args: any) => {
          try {
            return await withSecurity(
              config,
              td.name,
              async (session, liveConfig) => {
                const result = await td.handler(args, session, liveConfig);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
              },
              isOfficial
            );
          } catch (e) {
            return wrapError(e);
          }
        }
      );
      addedNames.push(td.name);
    }

    // Pass the SDK context so the plugin can dynamically register tools itself
    const pluginCtx = {
        mcp: {
            registerTool: (tool: any) => {
                server.tool(tool.name, tool.description, tool.schema, async (args: any) => {
                    return await tool.handler(args);
                });
            }
        }
    };

    if (typeof plugin.onLoad === "function") {
      try {
        await plugin.onLoad(pluginCtx as any);
      } catch (err: any) {
        process.stderr.write(\`  \\u001b[31m[!] Plugin \${plugin.name} onLoad failed: \${err?.message}\\u001b[0m\\n\`);
      }
    }
    
    loadedPluginNames.add(plugin.name);
    process.stderr.write(\`  [Plugin Loaded] \${plugin.name} v\${plugin.version}\\n\`);
    
    // Notify the client that tools have changed
    try {
        if ((server as any).server) {
            (server as any).server.sendToolListChanged();
        }
    } catch(e) {
        // Ignore if client doesn't support it or not connected yet
    }
  };

  // Add the built-in ecosystem tools
  server.tool(
    "list_plugins",
    "List all available Weavetab plugins that can be loaded.",
    {},
    async () => {
        const installed = listInstalledPlugins();
        const available = installed
            .filter(info => !loadedPluginNames.has(info.packageName))
            .map(info => \`- \${info.packageName}: \${info.manifest?.description || "No description"}\`);
            
        if (available.length === 0) {
            return { content: [{ type: "text", text: "No un-loaded plugins available." }] };
        }
        return { content: [{ type: "text", text: \`Available plugins:\\n\${available.join("\\n")}\\n\\nUse load_plugin to load one.\` }] };
    }
  );

  server.tool(
    "load_plugin",
    "Load a Weavetab plugin into the MCP context dynamically.",
    {
        name: z.string().describe("The exact name of the plugin to load")
    },
    async ({ name }) => {
        if (loadedPluginNames.has(name)) {
            return { content: [{ type: "text", text: \`Plugin \${name} is already loaded.\` }] };
        }
        
        const plugin = loadPluginByName(name);
        if (!plugin) {
            return { content: [{ type: "text", text: \`Plugin \${name} not found.\` }] };
        }
        
        await registerPluginTools(plugin);
        
        return { content: [{ type: "text", text: \`Successfully loaded plugin \${name}. The tools have been registered in your context.\` }] };
    }
  );

  // We load official core plugins by default, but leave others lazy.
  const allPlugins = discoverPlugins();
  for (const plugin of allPlugins) {
      const trust = resolvePluginTrust(plugin.name, verifiedPackages);
      const isLazy = plugin.manifest?.environments?.includes("mcp");
      if (trust.tier === "official" || !isLazy) {
          await registerPluginTools(plugin);
      }
  }

  `;

const newCode = code.substring(0, startIndex) + newLogic + code.substring(endIndex);
fs.writeFileSync(file, newCode, 'utf-8');
console.log('Successfully patched server.ts');