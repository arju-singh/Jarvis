/**
 * Tools — the capabilities your agent can call.
 *
 * A Tool is just { name, description, parameters (JSON Schema), run() }.
 * Add your own to `defaultTools`, or build your own array and pass it to Agent.
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Tool extends ToolDef {
  run: (args: any) => Promise<string>;
}

export const getTime: Tool = {
  name: "get_time",
  description: "Get the current date and time.",
  parameters: { type: "object", properties: {} },
  run: async () =>
    new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
};

export const getWeather: Tool = {
  name: "get_weather",
  description: "Get the current weather for a city (no API key — Open-Meteo).",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  run: async ({ city }: { city: string }) => {
    const g: any = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`).then((r) => r.json());
    const loc = g.results?.[0];
    if (!loc) return `Couldn't find "${city}".`;
    const w: any = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,wind_speed_10m`).then((r) => r.json());
    return `${loc.name}: ${w.current.temperature_2m}°C, wind ${w.current.wind_speed_10m} km/h.`;
  },
};

export const calculator: Tool = {
  name: "calculator",
  description: "Evaluate a basic arithmetic expression, e.g. (3+4)*5.",
  parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  run: async ({ expression }: { expression: string }) => {
    // Guard: digits, operators, parens, dot, spaces only — no identifiers/calls.
    if (!/^[-+*/().\d\s]+$/.test(expression)) return "Only basic arithmetic is allowed.";
    try { return String(Function(`"use strict";return (${expression})`)()); } catch { return "Could not evaluate."; }
  },
};

export const httpGet: Tool = {
  name: "http_get",
  description: "Fetch an http(s) URL and return the first ~1.5k chars of text.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  run: async ({ url }: { url: string }) => {
    if (!/^https?:\/\//i.test(url)) return "url must start with http(s)://";
    try { return (await (await fetch(url)).text()).slice(0, 1500); } catch (e) { return `fetch failed: ${(e as Error).message}`; }
  },
};

export const defaultTools: Tool[] = [getTime, getWeather, calculator, httpGet];
