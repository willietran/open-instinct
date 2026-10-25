/**
 * Voice notes arrive as audio attachments on a messaging channel. This turns the
 * bytes into text before the model sees the message. The audio is never stored: the
 * transcript is the message, and a presigned media URL expires within the hour.
 *
 * The endpoint is OpenAI-compatible (`POST {baseUrl}/audio/transcriptions`). Groq's
 * Whisper is the default because it is cheap, fast, and accepts m4a. Any other
 * OpenAI-compatible endpoint works through the TRANSCRIBE_* settings.
 */
import { checkPublicTarget, type Lookup } from "./net-guard.js";

export const DEFAULT_TRANSCRIBE_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-large-v3";
/** OpenAI's file transcription limit. Larger files are refused before the upload. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Short enough that a slow provider does not eat the reply budget for the turn. */
const TRANSCRIBE_TIMEOUT_MS = 15_000;

/** The formats OpenAI accepts. A MIME type is still the first signal, so a new one can still try. */
const AUDIO_EXTENSIONS = new Set(["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "caf", "aac", "ogg", "oga", "opus", "flac", "amr"]);

export interface AudioAttachment {
  url?: string;
  path?: string;
  mimeType?: string;
  name?: string;
}

/** True when an inbound attachment is audio the model cannot hear by itself. */
export function isVoiceNote(attachment: AudioAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("audio/")) return true;
  const name = attachment.name ?? attachment.url ?? attachment.path ?? "";
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
  return ext ? AUDIO_EXTENSIONS.has(ext) : false;
}

/** Turn one attachment into its spoken words. Throws with a short, owner-safe reason. */
export type VoiceNoteTranscriber = (attachment: AudioAttachment) => Promise<string>;

export interface TranscriberOptions {
  apiKey: string;
  /** Defaults to Groq. A trailing slash is fine. */
  baseUrl?: string;
  /** Defaults to `whisper-large-v3`. */
  model?: string;
  fetchImpl?: typeof fetch;
  /** DNS lookup used to keep the media URL on the public internet. Tests inject a stub. */
  lookup?: Lookup;
  maxBytes?: number;
  timeoutMs?: number;
}

function extensionFor(mimeType: string | undefined, name: string | undefined): string {
  const fromName = name ? /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase() : undefined;
  if (fromName && fromName.length <= 5) return fromName;
  const mime = (mimeType ?? "").toLowerCase();
  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") return "m4a";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/webm") return "webm";
  if (mime === "audio/ogg" || mime === "audio/opus") return "ogg";
  return "m4a";
}

/** Read a response body with a hard cap, so a hostile media host cannot exhaust memory. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > max) throw new Error("the voice note is too large to transcribe");
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new Error("the voice note is too large to transcribe");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function errorText(body: string): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) return "no detail";
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197)}...`;
}

export function createTranscriber(opts: TranscriberOptions): VoiceNoteTranscriber {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("a transcriber needs an API key");
  const baseUrl = (opts.baseUrl?.trim() || DEFAULT_TRANSCRIBE_BASE_URL).replace(/\/+$/, "");
  const model = opts.model?.trim() || DEFAULT_TRANSCRIBE_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_AUDIO_BYTES;
  const timeoutMs = opts.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;

  return async (attachment: AudioAttachment): Promise<string> => {
    const raw = attachment.url?.trim();
    if (!raw) throw new Error("the voice note has no download URL");

    // A media URL is sender-controlled input. Keep it on the public internet, like web_fetch.
    const check = await checkPublicTarget(raw, opts.lookup);
    if (!check.ok) throw new Error(`voice note download refused: ${check.reason}`);

    const res = await doFetch(check.target.url.toString(), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "audio/*" },
    });
    if (!res.ok) throw new Error(`voice note download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("the voice note is too large to transcribe");

    const bytes = await readCapped(res, maxBytes);
    if (bytes.byteLength === 0) throw new Error("the voice note is empty");

    const form = new FormData();
    form.set("model", model);
    const filename = `voice-note.${extensionFor(attachment.mimeType, attachment.name)}`;
    form.set("file", new Blob([bytes], { type: attachment.mimeType?.trim() || "application/octet-stream" }), filename);

    const out = await doFetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await out.text();
    if (!out.ok) throw new Error(`transcription failed: HTTP ${out.status} ${errorText(body)}`);

    let text = body.trim();
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      if (typeof parsed.text === "string") text = parsed.text.trim();
    } catch {
      // An OpenAI-compatible server may return plain text. Use it as is.
    }
    if (!text) throw new Error("the transcription was empty");
    return text;
  };
}
