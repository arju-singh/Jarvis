/**
 * Browser tool — macOS/Node port of Mark-XXXIX-OR's `browser_control` (and the
 * scraping half of `flight_finder`). Uses Playwright + Chromium to load a page,
 * render its JavaScript, and return the visible text so the brain can read pages
 * that a plain HTTP fetch can't (SPAs, search results, dynamic content).
 *
 * One headless browser is launched lazily and reused; a fresh page is opened and
 * closed per call. No fallbacks: navigation/extraction failures throw.
 */

import { chromium, type Browser } from "playwright";
import type { Tool } from "../types.js";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

export const browserTools: Tool[] = [
  {
    name: "browse_web",
    description:
      "Open a web page in a real (headless) browser, let its JavaScript render, and return " +
      "the visible text. Use for pages a simple fetch can't read — dynamic sites, search " +
      "results, dashboards, prices, listings. Input the full URL. For a plain keyword search " +
      "of the web, prefer web_search instead.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to open (must start with http/https)." },
        wait_for: {
          type: "string",
          description: "Optional CSS selector to wait for before reading (for slow/dynamic pages).",
        },
      },
      required: ["url"],
    },
    run: async ({ url, wait_for }: { url: string; wait_for?: string }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
      const b = await getBrowser();
      const page = await b.newPage({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (wait_for) await page.waitForSelector(wait_for, { timeout: 15_000 });
        else await page.waitForTimeout(1200); // let late JS settle
        const title = await page.title();
        const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\n{3,}/g, "\n\n").trim();
        if (!text) throw new Error(`Page loaded but had no visible text: ${url}`);
        const LIMIT = 12_000;
        const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n\n[page text truncated at ${LIMIT} chars]` : text;
        return `# ${title}\n${url}\n\n${body}`;
      } finally {
        await page.close();
      }
    },
  },
];
