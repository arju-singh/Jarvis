/**
 * Assistant tools — the everyday "personal assistant" capabilities.
 *
 *  - get_weather : real current conditions + today's range (Open-Meteo, no key).
 *  - web_search  : live web results (Brave Search API, needs BRAVE_API_KEY).
 *  - get_datetime: the current local date and time.
 *
 * No fallbacks, no mock data: every tool hits a real API and throws on failure.
 * Optional keys (Brave) are checked at call time, so a missing search key does
 * NOT block the brain from booting — it only fails if you actually ask to search.
 */

import type { Tool } from "../types.js";

async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// WMO weather interpretation codes → human description.
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
};

interface GeoResult {
  results?: Array<{
    latitude: number; longitude: number; name: string;
    country?: string; admin1?: string; timezone: string;
  }>;
}

interface Forecast {
  current: {
    temperature_2m: number; apparent_temperature: number;
    relative_humidity_2m: number; weather_code: number; wind_speed_10m: number;
  };
  daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
}

export const assistantTools: Tool[] = [
  {
    name: "get_weather",
    description:
      "Get the current weather and today's high/low for a place. Use for any " +
      "weather question. Input the city/place name (e.g. 'Delhi', 'San Francisco').",
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City or place name." } },
      required: ["location"],
    },
    run: async ({ location }: { location: string }) => {
      const geo = await getJson<GeoResult>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
      );
      const place = geo.results?.[0];
      if (!place) throw new Error(`Could not find a place called "${location}".`);

      const fc = await getJson<Forecast>(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min&timezone=auto`,
      );

      const c = fc.current;
      const desc = WEATHER_CODES[c.weather_code] ?? `code ${c.weather_code}`;
      const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
      return (
        `Weather in ${where}: ${desc}, ${Math.round(c.temperature_2m)}°C ` +
        `(feels like ${Math.round(c.apparent_temperature)}°C). ` +
        `Humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h. ` +
        `Today's range ${Math.round(fc.daily.temperature_2m_min[0])}° to ${Math.round(fc.daily.temperature_2m_max[0])}°C.`
      );
    },
  },
  {
    name: "web_search",
    description:
      "Search the live web for current information, facts, news, or anything you " +
      "don't already know. Returns the top results with titles and snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
    run: async ({ query }: { query: string }) => {
      const key = process.env.BRAVE_API_KEY;
      if (!key) {
        throw new Error(
          "Web search needs BRAVE_API_KEY. Get a free key at https://brave.com/search/api and add it to .env.",
        );
      }
      const data = await getJson<{ web?: { results?: Array<{ title: string; url: string; description: string }> } }>(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { headers: { Accept: "application/json", "X-Subscription-Token": key } },
      );
      const results = data.web?.results ?? [];
      if (!results.length) return `No web results for "${query}".`;
      return results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.description}\n   ${r.url}`)
        .join("\n");
    },
  },
  {
    name: "get_datetime",
    description: "Get the current local date and time. Use for 'what time is it', 'what's today's date', etc.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const now = new Date();
      return now.toLocaleString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    },
  },
];
