import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER, modelSpecOf, resolveModel } from "../src/model.js";

describe("resolveModel", () => {
  it("resolves catalog models by provider/id", () => {
    const m = resolveModel("anthropic/claude-fable-5-1");
    expect(m.provider).toBe("anthropic");
    expect(m.id).toBe("claude-fable-5-1");
    expect(m.api).toBe("anthropic-messages");
    expect(modelSpecOf(m)).toBe("anthropic/claude-fable-5-1");
  });

  it("keeps slashes inside model ids", () => {
    const m = resolveModel("openrouter/anthropic/claude-sonnet-4.5");
    expect(m.provider).toBe("openrouter");
    expect(m.id).toBe("anthropic/claude-sonnet-4.5");
  });

  it("builds an OpenAI-compatible model from env without storing the key", () => {
    const m = resolveModel("openai-compatible/llama-3.3-70b", { OPENAI_BASE_URL: "http://localhost:11434/v1", OPENAI_API_KEY: "sk-secret" });
    expect(m.provider).toBe(OPENAI_COMPATIBLE_PROVIDER);
    expect(m.id).toBe("llama-3.3-70b");
    expect(m.api).toBe("openai-completions");
    expect(m.baseUrl).toBe("http://localhost:11434/v1");
    expect(JSON.stringify(m)).not.toContain("sk-secret");
  });

  it("requires OPENAI_BASE_URL for openai-compatible", () => {
    expect(() => resolveModel("openai-compatible/x", {})).toThrow(/OPENAI_BASE_URL/);
  });

  it("defaults an OpenAI-compatible model to a 128k window and 16k output", () => {
    const m = resolveModel("openai-compatible/x", { OPENAI_BASE_URL: "https://ollama.com/v1" });
    expect(m.contextWindow).toBe(128_000);
    expect(m.maxTokens).toBe(16_384);
  });

  it("takes the context window and output cap from the operator", () => {
    const m = resolveModel("openai-compatible/kimi-k3", {
      OPENAI_BASE_URL: "https://ollama.com/v1",
      OPENAI_API_KEY: "sk-secret",
      INSTINCT_CONTEXT_WINDOW: "262144",
      INSTINCT_MAX_TOKENS: "32768",
    });
    expect(m.contextWindow).toBe(262_144);
    expect(m.maxTokens).toBe(32_768);
  });

  it("rejects a malformed window instead of booting with the default", () => {
    const env = { OPENAI_BASE_URL: "https://ollama.com/v1" };
    expect(() => resolveModel("openai-compatible/x", { ...env, INSTINCT_CONTEXT_WINDOW: "256k" })).toThrow(/INSTINCT_CONTEXT_WINDOW/);
    expect(() => resolveModel("openai-compatible/x", { ...env, INSTINCT_CONTEXT_WINDOW: "0" })).toThrow(/INSTINCT_CONTEXT_WINDOW/);
    expect(() => resolveModel("openai-compatible/x", { ...env, INSTINCT_MAX_TOKENS: "-1" })).toThrow(/INSTINCT_MAX_TOKENS/);
  });

  it("explains bad specs with examples", () => {
    expect(() => resolveModel("claude-fable-5-1")).toThrow(/provider\/model-id/);
    expect(() => resolveModel("nope/model")).toThrow(/unknown provider "nope"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/has no model "claude-99"/);
    expect(() => resolveModel("anthropic/claude-99")).toThrow(/anthropic\/claude-fable-5-1/);
  });
});
