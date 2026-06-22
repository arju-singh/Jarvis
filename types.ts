/**
 * Shared tool contract.
 *
 * Every capability Jarvis has — desktop control, assistant tasks, an MCP
 * product server — is just an object that satisfies this interface. The brain
 * doesn't know or care where a tool comes from; it only sees name + schema + run.
 */

export interface Tool {
  /** Unique tool name the model calls, e.g. "run_shell" or "arogya__list_bookings". */
  name: string;
  /** What the tool does — the model reads this to decide when to use it. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  input_schema: Record<string, unknown>;
  /** Executes the tool. Return a string for the model; throw to surface a real error. */
  run: (input: any) => Promise<string>;
}
