/**
 * Optional: load tools from MCP servers (Model Context Protocol).
 *
 * The agent is MCP-ready but doesn't depend on the SDK by default. To use it:
 *   npm i @modelcontextprotocol/sdk
 * then set MCP_SERVERS in the environment (JSON array), e.g.:
 *   MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'
 *
 * Each MCP tool is exposed as `<server>__<tool>` so it slots straight into the
 * same Tool[] your agent already uses.
 */
import type { Tool } from "./tools.js";

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export async function loadMcpTools(servers: McpServerSpec[]): Promise<Tool[]> {
  let ClientMod: any, StdioMod: any;
  try {
    ClientMod = await import("@modelcontextprotocol/sdk/client/index.js");
    StdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
  } catch {
    throw new Error("MCP support needs the SDK:  npm i @modelcontextprotocol/sdk");
  }

  const tools: Tool[] = [];
  for (const s of servers) {
    const client = new ClientMod.Client({ name: "agent-skeleton", version: "1.0.0" }, { capabilities: {} });
    const transport = new StdioMod.StdioClientTransport({ command: s.command, args: s.args ?? [], env: s.env });
    await client.connect(transport);
    const list = await client.listTools();
    for (const t of list.tools) {
      tools.push({
        name: `${s.name}__${t.name}`,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
        run: async (args: unknown) => {
          const r: any = await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
          return (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
        },
      });
    }
    console.error(`[mcp] ${s.name}: ${list.tools.length} tools`);
  }
  return tools;
}
