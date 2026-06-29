/**
 * Agent — the tool-calling loop. This is the teachable core:
 *   user message → brain → (tool calls? run them, feed results back) → repeat
 *   → final text answer.
 *
 * Brain and tools are injected, so you swap models or add capabilities without
 * touching this file. `events` give you full observability (what it called, why).
 */
import type { Brain } from "./providers.js";
import type { Tool } from "./tools.js";

export interface AgentEvents {
  onUser?(text: string): void;
  onToolCall?(name: string, args: unknown): void;
  onToolResult?(name: string, result: string): void;
  onReply?(text: string): void;
}

export interface AgentOptions {
  brain: Brain;
  tools?: Tool[];
  system?: string;
  events?: AgentEvents;
  maxSteps?: number; // guard against runaway tool loops
}

export class Agent {
  readonly brain: Brain;
  private tools: Tool[];
  private events: AgentEvents;
  private maxSteps: number;
  private messages: any[];

  constructor(opts: AgentOptions) {
    this.brain = opts.brain;
    this.tools = opts.tools ?? [];
    this.events = opts.events ?? {};
    this.maxSteps = opts.maxSteps ?? 8;
    this.messages = [{ role: "system", content: opts.system ?? "You are a helpful, concise assistant. Use tools when they fit." }];
  }

  /** Run one user turn through the multi-step tool loop; return the final text. */
  async run(userText: string): Promise<string> {
    this.events.onUser?.(userText);
    this.messages.push({ role: "user", content: userText });

    for (let step = 0; step < this.maxSteps; step++) {
      const { message, content, calls } = await this.brain.chat(this.messages, this.tools);
      this.messages.push(message);

      if (!calls.length) {
        this.events.onReply?.(content);
        return content;
      }
      for (const call of calls) {
        this.events.onToolCall?.(call.name, call.args);
        const tool = this.tools.find((t) => t.name === call.name);
        let result: string;
        try { result = tool ? await tool.run(call.args) : `ERROR: unknown tool "${call.name}"`; }
        catch (err) { result = `ERROR: ${(err as Error).message}`; }
        this.events.onToolResult?.(call.name, result);
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    const msg = `Stopped after ${this.maxSteps} steps.`;
    this.events.onReply?.(msg);
    return msg;
  }

  /** Forget the conversation (keeps the system prompt). */
  reset(): void {
    this.messages = [this.messages[0]];
  }
}
