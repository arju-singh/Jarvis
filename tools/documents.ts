/**
 * Document tool — macOS/Node port of the text-extraction core of Mark-XXXIX-OR's
 * `file_processor`. Pulls readable text out of PDF / DOCX / XLSX / CSV / TXT / JSON
 * files so the brain can summarize or answer questions about them.
 *
 * (Mark's image/audio/video/OCR paths are not ported here — those need a vision
 * model and ffmpeg; the current brain is text-only.)
 *
 * No fallbacks: unsupported types and read failures throw a clear error.
 */

import { readFile } from "node:fs/promises";
import { resolve, isAbsolute, extname } from "node:path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { Tool } from "../types.js";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}
const WORKDIR = resolve(requireEnv("JARVIS_WORKDIR"));

/** Allow absolute paths anywhere readable, else resolve under the workdir. */
function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(WORKDIR, p);
}

const LIMIT = 14_000;
function cap(text: string): string {
  const t = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!t) throw new Error("No readable text was extracted from the document.");
  return t.length > LIMIT ? `${t.slice(0, LIMIT)}\n\n[document text truncated at ${LIMIT} chars]` : t;
}

export const documentTools: Tool[] = [
  {
    name: "read_document",
    description:
      "Extract the text from a document file (PDF, Word .docx, Excel .xlsx/.xls, CSV, JSON, plain " +
      "text). ALWAYS call this whenever the user names a file to read/summarize — never assume the " +
      "file is missing; this tool reports it if it truly doesn't exist. Pass the file name as given " +
      "(it is resolved relative to the working directory).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the document file." },
      },
      required: ["path"],
    },
    run: async ({ path }: { path: string }) => {
      const file = resolvePath(path);
      const ext = extname(file).toLowerCase();
      const buf = await readFile(file);

      switch (ext) {
        case ".pdf": {
          const parser = new PDFParse({ data: buf });
          const result = await parser.getText();
          return cap(`PDF "${path}":\n\n${result.text}`);
        }
        case ".docx": {
          const { value } = await mammoth.extractRawText({ buffer: buf });
          return cap(`DOCX "${path}":\n\n${value}`);
        }
        case ".xlsx":
        case ".xls": {
          const wb = XLSX.read(buf, { type: "buffer" });
          const parts = wb.SheetNames.map(
            (name) => `--- sheet: ${name} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`,
          );
          return cap(`Spreadsheet "${path}":\n\n${parts.join("\n\n")}`);
        }
        case ".csv":
        case ".txt":
        case ".json":
        case ".md":
        case ".log":
          return cap(buf.toString("utf8"));
        default:
          throw new Error(
            `Unsupported document type "${ext}". Supported: .pdf .docx .xlsx .xls .csv .json .txt .md .log`,
          );
      }
    },
  },
];
