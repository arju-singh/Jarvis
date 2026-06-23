/**
 * screen_process — capture the screen and analyze it with a vision model.
 *
 * Pipeline: screencapture -> base64 JPEG -> Ollama /api/chat with an `images`
 * array (works against local Ollama or Ollama Cloud, reusing the brain's
 * OLLAMA_API_KEY). Set JARVIS_VISION_MODEL to a multimodal model the endpoint
 * serves (e.g. qwen2.5vl, llama3.2-vision).
 *
 * No mock: a real screenshot is sent to a real model. If no vision model is
 * available it fails loud telling you to set JARVIS_VISION_MODEL.
 *
 * Refs: https://docs.ollama.com/capabilities/vision , https://ollama.com/library/qwen2.5vl
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../types.js";

const run = promisify(execFile);

export const visionTools: Tool[] = [
  {
    name: "screen_process",
    description:
      "Look at what's currently on the screen and answer a question about it (read an error, " +
      "describe the page, identify the open app, transcribe text). Captures a screenshot and " +
      "analyzes it with a vision model.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to look for or the question about the screen." },
      },
    },
    run: async ({ prompt }: { prompt?: string }) => {
      const host = (process.env.JARVIS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
      const model = process.env.JARVIS_VISION_MODEL ?? "qwen2.5vl";
      const key = process.env.OLLAMA_API_KEY || process.env.JARVIS_OLLAMA_API_KEY;

      const file = join(tmpdir(), `jarvis-screen-${Date.now()}.jpg`);
      let stderr = "";
      try {
        const r = await run("screencapture", ["-x", "-t", "jpg", file], { timeout: 15_000 });
        stderr = r.stderr ?? "";
      } catch (e) {
        throw new Error(`Screen capture failed: ${(e as Error).message}`);
      }
      let buf: Buffer;
      try {
        buf = await readFile(file);
      } catch {
        // screencapture exits 0 but writes nothing when Screen Recording is denied.
        throw new Error(
          "Screen capture produced no image — grant Screen Recording permission to the app " +
            "running Jarvis (Terminal/node) in System Settings → Privacy & Security → Screen Recording, " +
            `then restart.${stderr ? ` (${stderr.trim()})` : ""}`,
        );
      }
      await unlink(file).catch(() => {});
      if (!buf.length) throw new Error("Screen capture was empty — check Screen Recording permission.");
      const image = buf.toString("base64");

      let res: Response;
      try {
        res = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt?.trim() || "Describe what is on this screen, concisely.", images: [image] }],
            stream: false,
          }),
        });
      } catch (e) {
        throw new Error(`Cannot reach vision model at ${host}: ${(e as Error).message}`);
      }
      if (!res.ok) {
        throw new Error(
          `Vision model error ${res.status}: ${(await res.text()).slice(0, 200)}. ` +
            `Is "${model}" available on the endpoint? Set JARVIS_VISION_MODEL to one it serves.`,
        );
      }
      const data = (await res.json()) as { message?: { content?: string } };
      return (data.message?.content ?? "").trim() || "(the vision model returned no description)";
    },
  },
];
