/**
 * CLI — chat with your agent in the terminal.
 *
 *   npm start
 *   you › what time is it?
 *   you › weather in Paris
 *   you › (3+4)*5
 *   you › exit
 *
 * Watches the agent think: each tool call and result is printed live.
 */
import readline from "node:readline";
import { Agent } from "./agent.js";
import { makeBrain } from "./providers.js";
import { defaultTools, type Tool } from "./tools.js";

const brain = makeBrain();
let tools: Tool[] = [...defaultTools];

// Optional MCP tools (only if configured + SDK installed).
if (process.env.MCP_SERVERS) {
  try {
    const { loadMcpTools } = await import("./mcp.js");
    tools = tools.concat(await loadMcpTools(JSON.parse(process.env.MCP_SERVERS)));
  } catch (err) {
    console.error("[mcp] skipped:", (err as Error).message);
  }
}

const agent = new Agent({
  brain,
  tools,
  system: "You are a sharp, concise assistant. Use tools when they fit; never invent tool output.",
  events: {
    onToolCall: (n, a) => console.log(`\x1b[2m  ↳ ${n}(${JSON.stringify(a)})\x1b[0m`),
    onToolResult: (n, r) => console.log(`\x1b[2m  ↳ ${n} → ${r.replace(/\s+/g, " ").slice(0, 100)}\x1b[0m`),
  },
});

console.log(`\x1b[36mAgent ready\x1b[0m — brain: ${brain.name}, tools: ${tools.map((t) => t.name).join(", ")}`);
console.log('Type a message, or "exit".\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you › " });
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (text === "exit" || text === "quit") return rl.close();
  if (text === "reset") { agent.reset(); console.log("(history cleared)"); return rl.prompt(); }
  if (text) {
    try { console.log(`\x1b[36magent ›\x1b[0m ${await agent.run(text)}`); }
    catch (err) { console.error("error:", (err as Error).message); }
  }
  rl.prompt();
});
rl.on("close", () => { console.log("bye."); process.exit(0); });
