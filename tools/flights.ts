/**
 * flight_finder — search real flight offers via the Amadeus Self-Service API.
 *
 * Flow: OAuth2 client-credentials token -> GET /v2/shopping/flight-offers.
 * Needs AMADEUS_API_KEY + AMADEUS_API_SECRET (free: https://developers.amadeus.com).
 * Defaults to the test environment; set AMADEUS_BASE=https://api.amadeus.com for live.
 *
 * No mock data: real API, fails loud without keys or on API errors.
 * Ref: https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search
 */

import type { Tool } from "../types.js";

function iata(s: unknown): string {
  const c = String(s ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new Error(`"${s}" must be a 3-letter IATA code (e.g. DEL, BOM, JFK).`);
  return c;
}

async function token(base: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export const flightTools: Tool[] = [
  {
    name: "flight_finder",
    description:
      "Search real flight offers. Provide origin and destination as 3-letter IATA codes " +
      "(DEL, BOM, JFK…) and a departure date YYYY-MM-DD. Optional returnDate and adults.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin IATA code, e.g. DEL." },
        destination: { type: "string", description: "Destination IATA code, e.g. BOM." },
        date: { type: "string", description: "Departure date YYYY-MM-DD." },
        returnDate: { type: "string", description: "Optional return date YYYY-MM-DD." },
        adults: { type: "number", description: "Passengers (default 1)." },
      },
      required: ["origin", "destination", "date"],
    },
    run: async ({ origin, destination, date, returnDate, adults }: {
      origin: string; destination: string; date: string; returnDate?: string; adults?: number;
    }) => {
      const id = process.env.AMADEUS_API_KEY;
      const secret = process.env.AMADEUS_API_SECRET;
      if (!id || !secret) {
        throw new Error("flight_finder needs AMADEUS_API_KEY and AMADEUS_API_SECRET. Free keys: https://developers.amadeus.com");
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`'date' must be YYYY-MM-DD, got "${date}".`);
      const base = process.env.AMADEUS_BASE ?? "https://test.api.amadeus.com";
      const access = await token(base, id, secret);

      const params = new URLSearchParams({
        originLocationCode: iata(origin),
        destinationLocationCode: iata(destination),
        departureDate: String(date),
        adults: String(adults && adults > 0 ? Math.floor(adults) : 1),
        max: "5",
        currencyCode: process.env.JARVIS_CURRENCY ?? "INR",
      });
      if (returnDate) params.set("returnDate", String(returnDate));

      const res = await fetch(`${base}/v2/shopping/flight-offers?${params}`, {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (!res.ok) throw new Error(`Amadeus search failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

      const offers = ((await res.json()) as { data?: any[] }).data ?? [];
      if (!offers.length) return `No flights found ${iata(origin)}→${iata(destination)} on ${date}.`;

      const lines = offers.slice(0, 5).map((o, i) => {
        const price = `${o.price?.total} ${o.price?.currency}`;
        const segs = o.itineraries?.[0]?.segments ?? [];
        const dep = segs[0]?.departure?.at ?? "?";
        const arr = segs[segs.length - 1]?.arrival?.at ?? "?";
        const carriers = [...new Set(segs.map((s: any) => s.carrierCode))].join("/");
        const stops = Math.max(0, segs.length - 1);
        return `${i + 1}. ${price} — ${carriers}, ${stops === 0 ? "nonstop" : stops + " stop(s)"}, dep ${dep}, arr ${arr}`;
      });
      return `Flights ${iata(origin)}→${iata(destination)} on ${date}:\n${lines.join("\n")}`;
    },
  },
];
