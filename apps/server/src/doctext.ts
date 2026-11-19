import { inflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free text extraction for the document types students get on eClass,
 * so the AI can summarize them. PDFs and images are sent to Gemini as-is (it reads them
 * natively); Office Open XML files are unzipped and their XML text is extracted here.
 */

export type PreparedDocument =
  | { kind: "inline"; mimeType: string; data: Buffer }
  /** Too big to send inline: goes through Gemini's file upload. */
  | { kind: "upload"; mimeType: string; data: Buffer }
  | { kind: "text"; text: string }
  | { kind: "unsupported"; reason: string };

const MAX_INLINE_BYTES = 18 * 1024 * 1024; // Gemini inline data limit is ~20MB per request
/** Gemini's file upload takes PDFs up to 50 MB. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * PDFs locked with the Standard security handler. Gemini cannot open them ("The document has
 * no pages"), and the ones seen on eClass need the professor's password, so they are refused
 * with a clear message instead of a Gemini error.
 */
export function isEncryptedPdf(data: Buffer): boolean {
  const tail = data.subarray(Math.max(0, data.length - 256 * 1024)).toString("latin1");
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(tail)) return true;
  // Linearized files keep the trailer near the start
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(data.subarray(0, 64 * 1024).toString("latin1"));
}
const MAX_TEXT_CHARS = 120_000;

/** Reads the entries of a .zip buffer (stored or deflated), returning name -> content. */
export function readZipEntries(buf: Buffer, wanted: (name: string) => boolean, maxEntries = 400): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory record (search the last 64KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid zip/Office file");
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries && n < maxEntries; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    ptr += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: 50 * 1024 * 1024 }));
  }
  return out;
}

function xmlToText(xml: string, paragraphTag: RegExp): string {
  return xml
    .replace(paragraphTag, "\n")
    .replace(/<w:tab\/>|<a:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

export function prepareDocumentForAi(
  name: string,
  contentType: string,
  data: Buffer,
  lang: "el" | "en" = "en",
): PreparedDocument {
  const ext = extOf(name);
  const ct = contentType.toLowerCase();
  const say = (el: string, en: string): PreparedDocument => ({ kind: "unsupported", reason: lang === "el" ? el : en });

  if (ext === "pdf" || ct.includes("pdf")) {
    if (isEncryptedPdf(data)) {
      return say(
        "Αυτό το PDF είναι κλειδωμένο με κωδικό από τον διδάσκοντα, οπότε το AI δεν μπορεί να το διαβάσει.",
        "This PDF is locked with a password by the instructor, so the AI can't read it.",
      );
    }
    if (data.length > MAX_UPLOAD_BYTES) {
      return say("Το PDF είναι πολύ μεγάλο για το AI (πάνω από 50 MB).", "The PDF is too large for the AI (over 50 MB).");
    }
    return { kind: data.length > MAX_INLINE_BYTES ? "upload" : "inline", mimeType: "application/pdf", data };
  }
  if (/^(png|jpe?g|webp|gif)$/.test(ext) || ct.startsWith("image/")) {
    if (data.length > MAX_INLINE_BYTES) return say("Η εικόνα είναι πολύ μεγάλη.", "The image is too large.");
    const mime = ct.startsWith("image/") ? ct.split(";")[0] : `image/${ext === "jpg" ? "jpeg" : ext}`;
    return { kind: "inline", mimeType: mime, data };
  }

  try {
    if (ext === "docx") {
      const files = readZipEntries(data, (n) => n === "word/document.xml");
      const xml = files.get("word/document.xml")?.toString("utf8") ?? "";
      return { kind: "text", text: xmlToText(xml, /<\/w:p>/g).slice(0, MAX_TEXT_CHARS) };
    }
    if (ext === "pptx") {
      const files = readZipEntries(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      const slides = [...files.entries()]
        .sort((a, b) => Number(a[0].match(/(\d+)\.xml$/)?.[1]) - Number(b[0].match(/(\d+)\.xml$/)?.[1]))
        .map(([n, buf], i) => `--- Slide ${i + 1} (${n.split("/").pop()}) ---\n${xmlToText(buf.toString("utf8"), /<\/a:p>/g)}`);
      return { kind: "text", text: slides.join("\n\n").slice(0, MAX_TEXT_CHARS) };
    }
    if (ext === "xlsx") {
      const files = readZipEntries(data, (n) => n === "xl/sharedStrings.xml");
      const xml = files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
      return { kind: "text", text: xmlToText(xml, /<\/si>/g).slice(0, MAX_TEXT_CHARS) };
    }
  } catch (err) {
    return say(`Δεν ήταν δυνατή η ανάγνωση του αρχείου (${(err as Error).message}).`, `Could not read the file (${(err as Error).message}).`);
  }

  const textLike =
    ct.startsWith("text/") ||
    /^(txt|md|csv|tsv|json|xml|html?|c|h|cpp|hpp|cc|java|py|js|ts|tsx|jsx|sql|sh|r|m|tex|ipynb|yml|yaml|ini|log|php|cs|go|rs|kt|swift|rb)$/.test(ext);
  if (textLike) {
    let text = data.toString("utf8");
    if (/^html?$/.test(ext) || ct.includes("html")) text = xmlToText(text, /<\/(p|div|li|h\d|tr)>/gi);
    return { kind: "text", text: text.slice(0, MAX_TEXT_CHARS) };
  }

  if (/^(doc|ppt|xls)$/.test(ext)) {
    return say(
      "Τα παλιά αρχεία Office (.doc/.ppt/.xls) δεν διαβάζονται από το AI. Χρειάζεται PDF ή νεότερη μορφή.",
      "Old Office formats (.doc/.ppt/.xls) can't be read by the AI; it needs a PDF or the newer format.",
    );
  }
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) {
    return say("Τα συμπιεσμένα αρχεία δεν διαβάζονται. Άνοιξε ένα αρχείο μέσα τους.", "Archives can't be read. Open a file inside it instead.");
  }
  return say(`Τα αρχεία τύπου .${ext || "άγνωστο"} δεν διαβάζονται ακόμα από το AI.`, `Files of type .${ext || "unknown"} can't be read by the AI yet.`);
}
