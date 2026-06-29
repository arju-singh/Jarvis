/**
 * sse — a tiny Server-Sent-Events hub for live, server→client push.
 * No deps, no WebSocket upgrade, works through proxies.
 *
 *   const hub = new SSEHub();
 *   app.get("/events", hub.handler);     // clients subscribe here
 *   hub.broadcast({ type: "ping" });     // push to everyone
 */
import type { Request, Response } from "express";

export class SSEHub {
  private clients = new Set<Response>();

  handler = (req: Request, res: Response): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
  };

  broadcast(event: unknown): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.clients) { try { c.write(data); } catch { this.clients.delete(c); } }
  }

  get size(): number { return this.clients.size; }
}
