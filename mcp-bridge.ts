/**
 * MCP bridge.
 *
 * Connects to one or more MCP servers (your own products: Arogya, ZetsGeo, etc.)
 * and exposes every remote tool as a local Tool the brain can call. Tool names
 * are namespaced (`<server>__<tool>`) to avoid collisions.
 *
 * No fallbacks: if a server fails to start or a tool call errors, it throws.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "./types.js";

export interface McpServerSpec {
  /** Short namespace, e.g. "arogya". Must match ^[a-zA-Z0-9_-]+$. */
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface TextBlock { type: "text"; text: string }

export async function loadMcpTools(specs: McpServerSpec[]): Promise<Tool[]> {
  const tools: Tool[] = [];

  for (const spec of specs) {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...process.env, ...spec.env } as Record<string, string>,
    });
    const client = new Client(
      { name: "jarvis", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const { tools: remoteTools } = await client.listTools();
    for (const rt of remoteTools) {
      tools.push({
        name: `${spec.name}__${rt.name}`,
        description: rt.description ?? rt.name,
        input_schema: rt.inputSchema as Record<string, unknown>,
        run: async (input: Record<string, unknown>) => {
          const result = await client.callTool({ name: rt.name, arguments: input });
          const blocks = (result.content ?? []) as Array<TextBlock | Record<string, unknown>>;
          return blocks
            .map((b) => ("type" in b && b.type === "text" ? (b as TextBlock).text : JSON.stringify(b)))
            .join("\n");
        },
      });
    }
    console.log(`[mcp] ${spec.name}: ${remoteTools.length} tools loaded`);
  }

  return tools;
}
