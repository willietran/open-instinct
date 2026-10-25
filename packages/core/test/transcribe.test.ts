import { describe, expect, it } from "vitest";
import { MAX_AUDIO_BYTES, createTranscriber, isVoiceNote } from "../src/transcribe.js";

const publicLookup = async (): Promise<string[]> => ["93.184.216.34"];

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, ...(init ? { init } : {}) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/x-m4a" } });
}

describe("isVoiceNote", () => {
  it("recognises audio by MIME type and by a known extension", () => {
    expect(isVoiceNote({ mimeType: "audio/x-m4a" })).toBe(true);
    expect(isVoiceNote({ name: "note.M4A" })).toBe(true);
    expect(isVoiceNote({ url: "https://files.example/note.m4a?token=abc" })).toBe(true);
    expect(isVoiceNote({ name: "note.caf" })).toBe(true);
  });

  it("leaves other attachments alone", () => {
    expect(isVoiceNote({ name: "invoice.pdf", mimeType: "application/pdf" })).toBe(false);
    expect(isVoiceNote({ name: "photo.jpg", mimeType: "image/jpeg" })).toBe(false);
    expect(isVoiceNote({})).toBe(false);
  });
});

describe("createTranscriber", () => {
  it("downloads the note and posts it to the transcriptions endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url === "https://files.example/note.m4a") return audioResponse();
      return new Response(JSON.stringify({ text: "  Book me a table at 7.  " }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const transcribe = createTranscriber({ apiKey: "sk-audio", baseUrl: "https://proxy.test/v1/", model: "gpt-transcribe", fetchImpl, lookup: publicLookup });

    const text = await transcribe({ url: "https://files.example/note.m4a", mimeType: "audio/x-m4a", name: "note.m4a" });
    expect(text).toBe("Book me a table at 7.");
    expect(calls.map((c) => c.url)).toEqual(["https://files.example/note.m4a", "https://proxy.test/v1/audio/transcriptions"]);

    const post = calls[1]!;
    expect(new Headers(post.init?.headers).get("authorization")).toBe("Bearer sk-audio");
    expect(post.init?.method).toBe("POST");
    const form = post.init?.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-note.m4a");
    expect(file.type).toBe("audio/x-m4a");
    expect(file.size).toBe(4);
  });

  it("defaults to Groq Whisper Large v3", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.includes("/audio/transcriptions") ? new Response(JSON.stringify({ text: "hello" }), { status: 200 }) : audioResponse(),
    );
    const transcribe = createTranscriber({ apiKey: "gsk_test", fetchImpl, lookup: publicLookup });
    await transcribe({ url: "https://files.example/note.m4a", mimeType: "audio/x-m4a" });

    expect(calls[1]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const form = calls[1]!.init?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
  });

  it("accepts a plain-text response from an OpenAI-compatible server", async () => {
    const { fetchImpl } = fakeFetch((call) => (call.url.includes("/audio/transcriptions") ? new Response("Move it to Friday.", { status: 200 }) : audioResponse()));
    const transcribe = createTranscriber({ apiKey: "sk-audio", fetchImpl, lookup: publicLookup });
    await expect(transcribe({ url: "https://files.example/note.m4a", mimeType: "audio/x-m4a" })).resolves.toBe("Move it to Friday.");
  });

  it("refuses a note larger than the provider limit before uploading", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("", { status: 200, headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } }));
    const transcribe = createTranscriber({ apiKey: "sk-audio", fetchImpl, lookup: publicLookup });
    await expect(transcribe({ url: "https://files.example/huge.m4a", mimeType: "audio/x-m4a" })).rejects.toThrow("too large");
    expect(calls).toHaveLength(1);
  });

  it("caps a streamed body even when the host sends no content-length", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }));
    const transcribe = createTranscriber({ apiKey: "sk-audio", maxBytes: 4, fetchImpl, lookup: publicLookup });
    await expect(transcribe({ url: "https://files.example/note.m4a", mimeType: "audio/x-m4a" })).rejects.toThrow("too large");
  });

  it("reports the provider's status and detail when transcription fails", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.url.includes("/audio/transcriptions")
        ? new Response(JSON.stringify({ error: { message: "unsupported audio format" } }), { status: 400 })
        : audioResponse(),
    );
    const transcribe = createTranscriber({ apiKey: "sk-audio", fetchImpl, lookup: publicLookup });
    await expect(transcribe({ url: "https://files.example/note.caf", mimeType: "audio/x-caf" })).rejects.toThrow("HTTP 400");
  });

  it("rejects a media URL that resolves inside the network", async () => {
    const { fetchImpl, calls } = fakeFetch(() => audioResponse());
    const transcribe = createTranscriber({ apiKey: "sk-audio", fetchImpl, lookup: async () => ["127.0.0.1"] });
    await expect(transcribe({ url: "https://rebind.test/note.m4a", mimeType: "audio/x-m4a" })).rejects.toThrow("refused");
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty note and an empty transcript", async () => {
    const emptyFile = fakeFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    const a = createTranscriber({ apiKey: "sk-audio", fetchImpl: emptyFile.fetchImpl, lookup: publicLookup });
    await expect(a({ url: "https://files.example/empty.m4a", mimeType: "audio/x-m4a" })).rejects.toThrow("empty");

    const emptyText = fakeFetch((call) => (call.url.includes("/audio/transcriptions") ? new Response(JSON.stringify({ text: "" }), { status: 200 }) : audioResponse()));
    const b = createTranscriber({ apiKey: "sk-audio", fetchImpl: emptyText.fetchImpl, lookup: publicLookup });
    await expect(b({ url: "https://files.example/note.m4a", mimeType: "audio/x-m4a" })).rejects.toThrow("empty");
  });
});
