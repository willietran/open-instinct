/**
 * Model resolution. A model spec is "provider/model-id" from the Pi catalog, or
 * "openai-compatible/<model-id>" for any OpenAI-compatible endpoint (vLLM, Ollama,
 * LiteLLM, a proxy). This is the only place in core that looks at env, and only the
 * env object it is handed.
 *
 * The catalog carries contextWindow and maxTokens for every built-in model. An
 * OpenAI-compatible endpoint has no catalog entry, so the operator declares them with
 * INSTINCT_CONTEXT_WINDOW and INSTINCT_MAX_TOKENS; the runtime sizes its transcript
 * fold from contextWindow.
 */
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

/** What an OpenAI-compatible model is assumed to hold when the operator says nothing. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const EXAMPLES = [
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-5.4",
  "openai-compatible/<model-id> (uses OPENAI_BASE_URL and OPENAI_API_KEY)",
];

export function resolveModel(spec: string, env: NodeJS.ProcessEnv = {}): Model<any> {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(unknownSpec(trimmed, "expected \"provider/model-id\""));
  }
  const provider = trimmed.slice(0, slash);
  // Model ids may themselves contain slashes (openrouter, huggingface), so split once.
  const id = trimmed.slice(slash + 1);

  if (provider === OPENAI_COMPATIBLE_PROVIDER) return openAiCompatibleModel(id, env);

  const model = (getBuiltinModel as (p: string, m: string) => Model<any> | undefined)(provider, id);
  if (model) return model;

  const providers = getBuiltinProviders() as readonly string[];
  if (!providers.includes(provider)) {
    throw new Error(unknownSpec(trimmed, `unknown provider "${provider}"`));
  }
  const known = (getBuiltinModels as (p: string) => Model<any>[])(provider)
    .map((m) => m.id)
    .slice(0, 12)
    .join(", ");
  throw new Error(unknownSpec(trimmed, `provider "${provider}" has no model "${id}". Known: ${known}`));
}

export function modelSpecOf(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function openAiCompatibleModel(id: string, env: NodeJS.ProcessEnv): Model<"openai-completions"> {
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      `Model "${OPENAI_COMPATIBLE_PROVIDER}/${id}" needs OPENAI_BASE_URL (for example http://localhost:11434/v1). ` +
        `Set OPENAI_API_KEY too when the endpoint checks it.`,
    );
  }
  // The API key is not stored on the model. The runtime hands it to Pi through getApiKey
  // so secrets stay out of anything that could be logged or persisted.
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positiveInt(env, "INSTINCT_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInt(env, "INSTINCT_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

/** Token counts come from an operator-set env var; a typo must stop the boot, not shrink the window. */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive integer (tokens), not "${raw}".`);
  }
  return Number(raw);
}

function unknownSpec(spec: string, why: string): string {
  return `Unknown model spec "${spec}": ${why}. Valid examples: ${EXAMPLES.join("; ")}.`;
}
