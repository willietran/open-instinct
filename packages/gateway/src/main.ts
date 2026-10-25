import { InkboxProvisioner } from "@open-instinct/inkbox";
import { consoleLogger } from "./logger.js";
import type { LinkPassthrough } from "./provision.js";
import { type GatewayServer, createGateway } from "./server.js";
import { UserStore } from "./store.js";
import { normalizeHandle } from "./validate.js";

export const DEFAULT_AGENT_IMAGE = "ghcr.io/mariagorskikh/open-instinct-agent:latest";

export interface GatewayEnv {
  port: number;
  publicUrl: string;
  dataDir: string;
  inkboxAdminApiKey?: string;
  inkboxBaseUrl?: string;
  /** Existing webhook key imported only for this handle when identity reuse is enabled. */
  inkboxAgentHandle?: string;
  inkboxSigningKey?: string;
  maritimeApiKey: string;
  maritimeBaseUrl?: string;
  agentImage: string;
  signupSecret?: string;
  /** GATEWAY_ALLOW_OPEN_SIGNUP=1: run the signup form without an invite code. Off by default. */
  allowOpenSignup: boolean;
  /** GATEWAY_TRUST_PROXY=1: rate-limit by X-Forwarded-For (Railway, Fly, a reverse proxy you run). */
  trustProxy: boolean;
  anthropicApiKey?: string;
  /** An OpenAI-compatible endpoint (Ollama Cloud, vLLM, LiteLLM) for agents without an Anthropic key. */
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  /** Model spec every agent boots with. Ignored when the Maritime LLM is on. */
  model?: string;
  /** Declared context window and output cap, in tokens, for the OpenAI-compatible endpoint. */
  contextWindow?: string;
  maxTokens?: string;
  /** Reasoning level for agents: off, minimal, low, medium, high, xhigh, max. */
  thinking?: string;
  /** GATEWAY_REUSE_IDENTITIES=1: adopt an existing identity that already holds the handle. Single owner only. */
  reuseIdentities: boolean;
  composioApiKey?: string;
  composioToolkits?: string;
  /** COMPOSIO_MODE forwarded to each agent: direct or router. Unset lets the agent choose from its model. */
  composioMode?: string;
  contextDevApiKey?: string;
  /** AMPLE_SIGNUP=1: each person's agent signs up for an Ample account of its own on its first deploy. */
  ampleSignup: boolean;
  /** An Ample credential set on the gateway. Never forwarded: every agent would share one account. */
  ampleSharedCredential: boolean;
  idleTtlSeconds?: number;
  useMaritimeLlm: boolean;
  maritimeModel?: string;
  link?: LinkPassthrough;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

/** The only place the gateway reads process.env. Everything else takes options. */
export function readEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  const port = Number(env["PORT"] ?? 8787);
  const maritimeApiKey = env["MARITIME_API_KEY"];
  if (!maritimeApiKey) throw new Error("MARITIME_API_KEY is required (the gateway forwards every message through Maritime).");
  const inkboxAgentHandle = normalizeHandle(env["INKBOX_AGENT_HANDLE"] ?? "") || undefined;
  const inkboxSigningKey = env["INKBOX_SIGNING_KEY"] || undefined;
  if (inkboxSigningKey && !inkboxAgentHandle) throw new Error("Set INKBOX_AGENT_HANDLE with INKBOX_SIGNING_KEY to identify the imported identity.");
  const publicUrl = env["GATEWAY_PUBLIC_URL"] ?? `http://localhost:${port}`;
  const idle = env["INSTINCT_IDLE_TTL_SECONDS"] ? Number(env["INSTINCT_IDLE_TTL_SECONDS"]) : undefined;
  const linkClientId = env["LINK_CLIENT_ID"] || undefined;
  const link: LinkPassthrough | undefined = linkClientId
    ? {
        clientId: linkClientId,
        ...(env["LINK_CLIENT_SECRET"] ? { clientSecret: env["LINK_CLIENT_SECRET"] } : {}),
        ...(env["STRIPE_PUBLISHABLE_KEY"] ? { stripePublishableKey: env["STRIPE_PUBLISHABLE_KEY"] } : {}),
      }
    : undefined;
  return {
    port,
    publicUrl,
    dataDir: env["GATEWAY_DATA_DIR"] ?? "./.instinct-gateway",
    inkboxAdminApiKey: env["INKBOX_ADMIN_API_KEY"] || undefined,
    inkboxBaseUrl: env["INKBOX_BASE_URL"] || undefined,
    inkboxAgentHandle,
    inkboxSigningKey,
    maritimeApiKey,
    maritimeBaseUrl: env["MARITIME_API_URL"] || undefined,
    agentImage: env["INSTINCT_AGENT_IMAGE"] || DEFAULT_AGENT_IMAGE,
    signupSecret: env["GATEWAY_SIGNUP_SECRET"] || undefined,
    allowOpenSignup: truthy(env["GATEWAY_ALLOW_OPEN_SIGNUP"]) || truthy(env["GATEWAY_OPEN_SIGNUP"]),
    trustProxy: truthy(env["GATEWAY_TRUST_PROXY"]),
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    openaiApiKey: env["OPENAI_API_KEY"] || undefined,
    openaiBaseUrl: env["OPENAI_BASE_URL"] || undefined,
    model: env["INSTINCT_MODEL"] || undefined,
    contextWindow: env["INSTINCT_CONTEXT_WINDOW"] || undefined,
    maxTokens: env["INSTINCT_MAX_TOKENS"] || undefined,
    thinking: env["INSTINCT_THINKING"] || undefined,
    reuseIdentities: truthy(env["GATEWAY_REUSE_IDENTITIES"]),
    composioApiKey: env["COMPOSIO_API_KEY"] || undefined,
    composioToolkits: env["COMPOSIO_TOOLKITS"] || env["INSTINCT_COMPOSIO_TOOLKITS"] || undefined,
    composioMode: env["COMPOSIO_MODE"]?.trim() || undefined,
    contextDevApiKey: env["CONTEXT_DEV_API_KEY"] || undefined,
    ampleSignup: truthy(env["AMPLE_SIGNUP"]),
    ampleSharedCredential: Boolean(env["AMPLE_CLIENT_ID"] || env["AMPLE_CLIENT_SECRET"] || env["AMPLE_TOKEN"]),
    idleTtlSeconds: idle !== undefined && Number.isFinite(idle) ? idle : undefined,
    useMaritimeLlm: truthy(env["INSTINCT_USE_MARITIME_LLM"]),
    maritimeModel: env["INSTINCT_MARITIME_MODEL"] || undefined,
    link,
  };
}

/**
 * Signup provisions an Inkbox identity and a Maritime VM, both billed to the
 * operator. With a provisioner configured the form is live, so it must be
 * behind an invite code unless the operator opts into open signup by name.
 */
export function checkSignupPolicy(cfg: Pick<GatewayEnv, "inkboxAdminApiKey" | "signupSecret" | "allowOpenSignup"> & { reuseIdentities?: boolean }): { ok: true; open: boolean } | { ok: false; reason: string } {
  if (!cfg.inkboxAdminApiKey) return { ok: true, open: false };
  if (cfg.signupSecret) return { ok: true, open: false };
  if (cfg.reuseIdentities) return { ok: false, reason: "GATEWAY_REUSE_IDENTITIES requires GATEWAY_SIGNUP_SECRET. Keep the invite code private to the identity owner." };
  if (cfg.allowOpenSignup) return { ok: true, open: true };
  return {
    ok: false,
    reason:
      "INKBOX_ADMIN_API_KEY is set but GATEWAY_SIGNUP_SECRET is not. Every signup creates a billed identity and VM, so set an invite code, " +
      "or set GATEWAY_ALLOW_OPEN_SIGNUP=1 to run the form open to the internet on purpose.",
  };
}

/** Settings every agent gets. Only keys safe to share across people belong here. */
export function agentExtraEnv(cfg: Pick<GatewayEnv, "contextDevApiKey" | "ampleSignup" | "composioMode">): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (cfg.composioMode) env["COMPOSIO_MODE"] = cfg.composioMode;
  if (cfg.contextDevApiKey) env["CONTEXT_DEV_API_KEY"] = cfg.contextDevApiKey;
  if (cfg.ampleSignup) env["AMPLE_SIGNUP"] = "1";
  return Object.keys(env).length > 0 ? env : undefined;
}

export function startGateway(cfg: GatewayEnv): GatewayServer {
  const log = consoleLogger;
  const policy = checkSignupPolicy(cfg);
  if (!policy.ok) throw new Error(policy.reason);
  if (policy.open) {
    log.warn("gateway.open_signup", {
      warning: "Signup is open to anyone. Each signup bills your Maritime wallet and Inkbox plan. Set GATEWAY_SIGNUP_SECRET to close it.",
    });
  }

  const store = new UserStore(cfg.dataDir);
  const inkbox = cfg.inkboxAdminApiKey
    ? new InkboxProvisioner({ adminApiKey: cfg.inkboxAdminApiKey, baseUrl: cfg.inkboxBaseUrl })
    : undefined;
  if (!inkbox) log.warn("gateway.relay_only", { reason: "INKBOX_ADMIN_API_KEY not set; signup disabled" });
  if (!cfg.publicUrl.startsWith("https://")) log.warn("gateway.public_url_not_https", { publicUrl: cfg.publicUrl });
  if (cfg.ampleSharedCredential) {
    log.warn("gateway.ample_credential_ignored", {
      reason: "An Ample credential is not forwarded to agents: they would all deploy into one account. Set AMPLE_SIGNUP=1 to give each person an account of their own.",
    });
  }

  const server = createGateway({
    store,
    publicUrl: cfg.publicUrl,
    inkbox,
    inkboxBaseUrl: cfg.inkboxBaseUrl,
    inkboxAgentHandle: cfg.inkboxAgentHandle,
    inkboxSigningKey: cfg.inkboxSigningKey,
    maritime: {
      apiKey: cfg.maritimeApiKey,
      baseUrl: cfg.maritimeBaseUrl,
      agentImage: cfg.agentImage,
      idleTtlSeconds: cfg.idleTtlSeconds,
      useMaritimeLlm: cfg.useMaritimeLlm,
      maritimeModel: cfg.maritimeModel,
      extraEnv: agentExtraEnv(cfg),
    },
    signupSecret: cfg.signupSecret,
    anthropicApiKey: cfg.anthropicApiKey,
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
    model: cfg.model,
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
    thinking: cfg.thinking,
    reuseIdentities: cfg.reuseIdentities,
    composioApiKey: cfg.composioApiKey,
    composioToolkits: cfg.composioToolkits,
    link: cfg.link,
    trustProxy: cfg.trustProxy,
    logger: log,
    // The triage endpoint called with an identity-scoped key answers for that identity, so its QR fits the user.
    routerInfoFor: (user) => new InkboxProvisioner({ adminApiKey: user.identityApiKey, baseUrl: cfg.inkboxBaseUrl }).routerInfo(),
  });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("gateway.listening", { port: cfg.port, publicUrl: cfg.publicUrl, users: store.all().length, signup: Boolean(inkbox), link: Boolean(cfg.link) });
    server.resumePending();
    // Older subscriptions were made before call.ended existed; each boot tops them up.
    void server.backfillWebhookEvents();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    server.close(() => { void server.drainWebhooks().finally(() => process.exit(0)); });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    startGateway(readEnv(process.env));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
