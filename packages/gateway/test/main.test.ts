import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_IMAGE, agentExtraEnv, checkSignupPolicy, readEnv } from "../src/main.js";

describe("readEnv", () => {
  it("binds an imported signing key to the configured handle", () => {
    const cfg = readEnv({ MARITIME_API_KEY: "mk", INKBOX_AGENT_HANDLE: " @Maria ", INKBOX_SIGNING_KEY: "test_signing" });
    expect(cfg.inkboxAgentHandle).toBe("maria");
    expect(cfg.inkboxSigningKey).toBe("test_signing");
    expect(() => readEnv({ MARITIME_API_KEY: "mk", INKBOX_SIGNING_KEY: "test_signing" })).toThrow(/INKBOX_AGENT_HANDLE/);
  });

  it("requires MARITIME_API_KEY and reads the signup, Composio, Maritime LLM and Link settings", () => {
    expect(() => readEnv({})).toThrow(/MARITIME_API_KEY/);
    const cfg = readEnv({
      MARITIME_API_KEY: "mk",
      INKBOX_ADMIN_API_KEY: "ak",
      GATEWAY_ALLOW_OPEN_SIGNUP: "1",
      GATEWAY_TRUST_PROXY: "true",
      COMPOSIO_API_KEY: "cmp",
      COMPOSIO_TOOLKITS: "gmail,slack",
      CONTEXT_DEV_API_KEY: "ctxt_secret_test",
      INSTINCT_USE_MARITIME_LLM: "1",
      INSTINCT_MARITIME_MODEL: "gpt-5.5",
      LINK_CLIENT_ID: "lc_1",
      LINK_CLIENT_SECRET: "ls_1",
      STRIPE_PUBLISHABLE_KEY: "pk_test_1",
      OPENAI_API_KEY: "ollama-key",
      OPENAI_BASE_URL: "https://ollama.com/v1",
      INSTINCT_MODEL: "openai-compatible/deepseek-v4.1-flash",
      INSTINCT_CONTEXT_WINDOW: "1048576",
      INSTINCT_MAX_TOKENS: "131072",
      GATEWAY_REUSE_IDENTITIES: "1",
    });
    expect(cfg.agentImage).toBe(DEFAULT_AGENT_IMAGE);
    expect(cfg.allowOpenSignup).toBe(true);
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.composioToolkits).toBe("gmail,slack");
    expect(cfg.contextDevApiKey).toBe("ctxt_secret_test");
    expect(cfg.useMaritimeLlm).toBe(true);
    expect(cfg.maritimeModel).toBe("gpt-5.5");
    expect(cfg.openaiBaseUrl).toBe("https://ollama.com/v1");
    expect(cfg.model).toBe("openai-compatible/deepseek-v4.1-flash");
    expect(cfg.contextWindow).toBe("1048576");
    expect(cfg.maxTokens).toBe("131072");
    expect(cfg.reuseIdentities).toBe(true);
    expect(cfg.link).toEqual({ clientId: "lc_1", clientSecret: "ls_1", stripePublishableKey: "pk_test_1" });

    const plain = readEnv({ MARITIME_API_KEY: "mk", LINK_CLIENT_SECRET: "orphan" });
    expect(plain.allowOpenSignup).toBe(false);
    expect(plain.useMaritimeLlm).toBe(false);
    expect(plain.reuseIdentities).toBe(false);
    expect(plain.link).toBeUndefined();
  });
});

describe("Ample for every agent", () => {
  it("forwards AMPLE_SIGNUP so each person's agent gets its own account, and never a shared credential", () => {
    const cfg = readEnv({
      MARITIME_API_KEY: "mk",
      AMPLE_SIGNUP: "1",
      AMPLE_CLIENT_ID: "agent_shared",
      AMPLE_CLIENT_SECRET: "ample_agent_shared_secret",
      CONTEXT_DEV_API_KEY: "ctxt_secret_test",
    });
    expect(cfg.ampleSignup).toBe(true);
    expect(cfg.ampleSharedCredential).toBe(true);
    const env = agentExtraEnv(cfg);
    expect(env).toEqual({ CONTEXT_DEV_API_KEY: "ctxt_secret_test", AMPLE_SIGNUP: "1" });
    expect(JSON.stringify(env)).not.toContain("ample_agent_shared_secret");
    expect(JSON.stringify(env)).not.toContain("agent_shared");
  });

  it("forwards COMPOSIO_MODE so operators can pin the session mode", () => {
    const cfg = readEnv({ MARITIME_API_KEY: "mk", COMPOSIO_MODE: " router " });
    expect(cfg.composioMode).toBe("router");
    expect(agentExtraEnv(cfg)).toEqual({ COMPOSIO_MODE: "router" });
  });

  it("sends nothing extra when neither Context.dev nor Ample is on", () => {
    const cfg = readEnv({ MARITIME_API_KEY: "mk" });
    expect(cfg.ampleSignup).toBe(false);
    expect(cfg.ampleSharedCredential).toBe(false);
    expect(agentExtraEnv(cfg)).toBeUndefined();
  });
});

describe("checkSignupPolicy", () => {
  it("requires a private invite code when reusing identities, even with open signup enabled", () => {
    const cfg = readEnv({ MARITIME_API_KEY: "mk", INKBOX_ADMIN_API_KEY: "ak", GATEWAY_REUSE_IDENTITIES: "1", GATEWAY_ALLOW_OPEN_SIGNUP: "1" });
    expect(checkSignupPolicy(cfg)).toMatchObject({ ok: false, reason: expect.stringContaining("GATEWAY_SIGNUP_SECRET") });
    expect(checkSignupPolicy({ ...cfg, signupSecret: "private-code" })).toEqual({ ok: true, open: false });
  });

  it("refuses to start an open, billed signup form unless the operator opts in by name", () => {
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: undefined, allowOpenSignup: false })).toMatchObject({ ok: false, reason: expect.stringContaining("GATEWAY_SIGNUP_SECRET") });
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: "code", allowOpenSignup: false })).toEqual({ ok: true, open: false });
    expect(checkSignupPolicy({ inkboxAdminApiKey: "ak", signupSecret: undefined, allowOpenSignup: true })).toEqual({ ok: true, open: true });
    // Relay-only gateways have no form to protect.
    expect(checkSignupPolicy({ inkboxAdminApiKey: undefined, signupSecret: undefined, allowOpenSignup: false })).toEqual({ ok: true, open: false });
  });
});
