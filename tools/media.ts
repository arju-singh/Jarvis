/**
 * Media tools — the macOS-portable port of Mark-XXXIX-OR's `youtube_video`.
 *
 * `youtube_transcript` fetches a video's caption track (no API key) and returns
 * the plain text, which the brain then summarizes/answers from. Mark's Windows
 * bits (tkinter prompt, `cmd /c start`) are dropped; this is pure fetch+parse.
 *
 * No fallbacks: if a video has no captions or YouTube changes its page shape,
 * this throws a clear error rather than inventing a summary.
 */

import type { Tool } from "../types.js";

/** Pull the 11-char video id out of a URL or accept a bare id. */
function videoId(input: string): string {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m =
    s.match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([\w-]{11})/) ??
    s.match(/([\w-]{11})/);
  if (!m) throw new Error(`Could not find a YouTube video id in "${input}".`);
  return m[1];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} for ${url}`);
  return res.text();
}

export const mediaTools: Tool[] = [
  {
    name: "youtube_transcript",
    description:
      "Fetch the transcript/captions of a YouTube video so you can summarize it or answer " +
      "questions about it. Input the video URL or id. Returns the spoken text (may be long).",
    input_schema: {
      type: "object",
      properties: {
        video: { type: "string", description: "YouTube URL or 11-char video id." },
      },
      required: ["video"],
    },
    run: async ({ video }: { video: string }) => {
      const id = videoId(video);
      const page = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`);

      const m = page.match(/"captionTracks":(\[.*?\])/s);
      if (!m) {
        throw new Error(
          "No captions found for this video (it may have captions disabled or be age/region restricted).",
        );
      }
      const tracks = JSON.parse(m[1]) as Array<{ baseUrl: string; languageCode?: string; kind?: string }>;
      if (!tracks.length) throw new Error("This video has no caption tracks.");

      // Prefer English; fall back to the first available track.
      const track =
        tracks.find((t) => t.languageCode === "en") ??
        tracks.find((t) => t.languageCode?.startsWith("en")) ??
        tracks[0];

      const xml = await fetchText(track.baseUrl);
      const text = xml
        .replace(/<text[^>]*>/g, "")
        .split("</text>")
        .map((s) =>
          s
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;#39;|&#39;/g, "'")
            .replace(/&amp;quot;|&quot;/g, '"')
            .replace(/&amp;|&amp;amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim(),
        )
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!text) throw new Error("Caption track was empty.");
      // Cap to keep the model prompt sane; note if truncated.
      const LIMIT = 12_000;
      return text.length > LIMIT
        ? `${text.slice(0, LIMIT)}\n\n[transcript truncated at ${LIMIT} chars]`
        : text;
    },
  },
];
