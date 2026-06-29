/**
 * Library entry — import the agent into your own project.
 *
 *   import { Agent, makeBrain, defaultTools } from "agent-skeleton";
 *   const agent = new Agent({ brain: makeBrain(), tools: defaultTools });
 *   console.log(await agent.run("weather in Tokyo"));
 */
export { Agent, type AgentOptions, type AgentEvents } from "./agent.js";
export { makeBrain, type Brain, type BrainResult, type ParsedCall } from "./providers.js";
export { defaultTools, getTime, getWeather, calculator, httpGet, type Tool, type ToolDef } from "./tools.js";
export { loadMcpTools, type McpServerSpec } from "./mcp.js";
