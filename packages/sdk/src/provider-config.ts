import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel as compatGetModel } from "@earendil-works/pi-ai/compat";
import type { StorageNamespace } from "./context";
import { loadOAuthCredentials } from "./oauth";

export type ThinkingLevel = "none" | "low" | "medium" | "high";

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
  useProxy: boolean;
  proxyUrl: string;
  thinking: ThinkingLevel;
  followMode: boolean;
  expandToolCalls: boolean;
  apiType?: string;
  customBaseUrl?: string;
  authMethod?: "apikey" | "oauth";
}

function storageKey(ns: StorageNamespace): string {
  return `${ns.localStoragePrefix}-provider-config`;
}

export const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const API_TYPES = [
  {
    id: "openai-completions",
    name: "OpenAI Completions",
    hint: "Most compatible — Ollama, vLLM, LMStudio, etc.",
  },
  {
    id: "openai-responses",
    name: "OpenAI Responses",
    hint: "Newer OpenAI API format",
  },
  { id: "anthropic-messages", name: "Anthropic Messages", hint: "Claude API" },
  {
    id: "google-generative-ai",
    name: "Google Generative AI",
    hint: "Gemini API",
  },
  {
    id: "azure-openai-responses",
    name: "Azure OpenAI Responses",
    hint: "Azure-hosted OpenAI",
  },
  {
    id: "openai-codex-responses",
    name: "OpenAI Codex Responses",
    hint: "ChatGPT subscription models",
  },
  {
    id: "google-gemini-cli",
    name: "Google Gemini CLI",
    hint: "Cloud Code Assist",
  },
  { id: "google-vertex", name: "Google Vertex AI", hint: "Vertex AI endpoint" },
];

export function loadSavedConfig(ns: StorageNamespace): ProviderConfig | null {
  try {
    const saved = localStorage.getItem(storageKey(ns));
    if (saved) {
      const config = JSON.parse(saved);
      if (config.proxyUrl === undefined) config.proxyUrl = "";
      if (config.followMode === undefined) config.followMode = true;
      if (config.expandToolCalls === undefined) config.expandToolCalls = false;
      if (config.apiType === undefined) config.apiType = "";
      if (config.customBaseUrl === undefined) config.customBaseUrl = "";
      if (config.authMethod === undefined) config.authMethod = "apikey";
      if (config.authMethod === "oauth") {
        const creds = loadOAuthCredentials(ns, config.provider);
        if (creds) config.apiKey = creds.access;
      }
      return config;
    }
  } catch {}
  return null;
}

export function saveConfig(ns: StorageNamespace, config: ProviderConfig) {
  localStorage.setItem(storageKey(ns), JSON.stringify(config));
}

export function buildCustomModel(config: ProviderConfig): Model<Api> | null {
  if (!config.apiType || !config.customBaseUrl || !config.model) return null;
  return {
    id: config.model,
    name: config.model,
    api: config.apiType as Api,
    provider: "custom",
    baseUrl: config.customBaseUrl,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  };
}

// Default CORS proxy URL. Leave empty unless you have deployed the bundled
// Cloudflare Worker (see packages/proxy/README.md) and want it used
// automatically for CORS-restricted providers without per-user setup.
export const DEFAULT_CORS_PROXY_URL =
  "https://office-agents-cors-proxy.longpt-hrt.workers.dev";

// Providers whose API endpoints do not send CORS headers and therefore cannot
// be called directly from a browser (Office add-in taskpane). They require a
// CORS proxy. See packages/proxy/ for a ready-to-deploy Cloudflare Worker.
export const PROVIDERS_REQUIRING_CORS_PROXY = new Set([
  "anthropic",
  "opencode",
  "opencode-go",
]);

export function providerNeedsCorsProxy(provider: string): boolean {
  return PROVIDERS_REQUIRING_CORS_PROXY.has(provider);
}

// OpenCode Go/Zen gateways reject requests without a stable per-conversation
// session ID in x-opencode-session (400 MissingSessionID).
export function needsOpencodeSessionHeader(model: Model<Api>): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") {
    return true;
  }
  return (model.baseUrl ?? "").includes("opencode.ai");
}

// Effective proxy URL for a config. An explicit, user-enabled proxy always
// wins. Otherwise CORS-restricted providers fall back to any configured
// proxy URL (auto-enable) and then to the bundled default proxy URL.
export function resolveProxyUrl(config: ProviderConfig): string {
  if (config.useProxy && config.proxyUrl) return config.proxyUrl;
  if (providerNeedsCorsProxy(config.provider)) {
    return config.proxyUrl || DEFAULT_CORS_PROXY_URL;
  }
  return "";
}

// Returns a descriptive error when a CORS-restricted provider is configured
// without any usable proxy (the common cause of opaque "Connection error").
export function getProxySetupError(config: ProviderConfig): string | null {
  if (!providerNeedsCorsProxy(config.provider)) return null;
  if (resolveProxyUrl(config)) return null;
  return `${config.provider} cannot be called directly from the browser (no CORS headers). Enable "CORS Proxy" in Settings and enter a proxy URL, or deploy the bundled proxy (packages/proxy) and set DEFAULT_CORS_PROXY_URL.`;
}

export function applyProxyToModel(
  model: Model<Api>,
  config: ProviderConfig,
): Model<Api> {
  if (!model.baseUrl) return model;
  const proxyUrl = resolveProxyUrl(config);
  if (!proxyUrl) return model;
  return {
    ...model,
    baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
  };
}

// ─── Dynamic Model Fetching ─────────────────────────────────────

interface ProviderModelsConfig {
  baseUrl: string;
  path: string;
  authType: "bearer" | "x-api-key" | "query-key";
  responsePath: string;
  extraHeaders?: Record<string, string>;
}

const PROVIDER_MODELS_CONFIG: Record<string, ProviderModelsConfig> = {
  "opencode-go": {
    baseUrl: "https://opencode.ai/zen/go/v1",
    path: "/models",
    authType: "bearer",
    responsePath: "data",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    path: "/models",
    authType: "bearer",
    responsePath: "data",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    path: "/v1/models",
    authType: "x-api-key",
    responsePath: "data",
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    path: "/models",
    authType: "query-key",
    responsePath: "models",
  },
};

const MODELS_CACHE_TTL = 60 * 60 * 1000;

function modelsCacheKey(ns: StorageNamespace, provider: string): string {
  return `${ns.localStoragePrefix}-models-cache-${provider}`;
}

export interface ModelsCacheEntry {
  ids: string[];
  fetchedAt: number;
}

export function loadCachedModels(
  ns: StorageNamespace,
  provider: string,
): ModelsCacheEntry | null {
  try {
    const raw = localStorage.getItem(modelsCacheKey(ns, provider));
    if (!raw) return null;
    const entry = JSON.parse(raw) as ModelsCacheEntry;
    if (Date.now() - entry.fetchedAt > MODELS_CACHE_TTL) return null;
    return entry;
  } catch {
    return null;
  }
}

export function saveCachedModels(
  ns: StorageNamespace,
  provider: string,
  ids: string[],
): void {
  try {
    const entry: ModelsCacheEntry = { ids, fetchedAt: Date.now() };
    localStorage.setItem(modelsCacheKey(ns, provider), JSON.stringify(entry));
  } catch {}
}

export function supportsDynamicModels(provider: string): boolean {
  return provider in PROVIDER_MODELS_CONFIG;
}

export function isModelFree(provider: string, modelId: string): boolean {
  if (!modelId) return false;
  if (modelId.toLowerCase().includes("free")) return true;
  try {
    const m = compatGetModel(provider as never, modelId) as Model<Api>;
    return m.cost.input === 0 && m.cost.output === 0;
  } catch {
    return false;
  }
}

export function shouldRequireApiKey(
  provider: string,
  modelId: string,
): boolean {
  return !isModelFree(provider, modelId);
}

export async function fetchModelsFromProvider(
  provider: string,
  apiKey: string,
  proxyUrl: string,
): Promise<string[]> {
  const config = PROVIDER_MODELS_CONFIG[provider];
  if (!config) return [];

  let url = `${config.baseUrl}${config.path}`;
  const headers: Record<string, string> = {
    ...(config.extraHeaders || {}),
  };

  if (config.authType === "bearer") {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  } else if (config.authType === "x-api-key") {
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (config.authType === "query-key") {
    if (apiKey) url += `?key=${encodeURIComponent(apiKey)}`;
  }

  let fetchUrl = url;
  if (proxyUrl) {
    fetchUrl = `${proxyUrl}/?url=${encodeURIComponent(url)}`;
  }

  const response = await fetch(fetchUrl, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch models: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json();
  const list = body[config.responsePath] as Array<{ id: string }>;
  if (!Array.isArray(list)) return [];

  return list.map((item) => item.id).filter(Boolean);
}

const PROVIDER_DEFAULTS: Record<
  string,
  { api: Api; baseUrl: string; contextWindow: number; maxTokens: number }
> = {
  "opencode-go": {
    api: "openai-completions" as Api,
    baseUrl: "https://opencode.ai/zen/go/v1",
    contextWindow: 1000000,
    maxTokens: 131072,
  },
  openai: {
    api: "openai-completions" as Api,
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
    maxTokens: 16384,
  },
  anthropic: {
    api: "anthropic-messages" as Api,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 64000,
  },
  google: {
    api: "google-generative-ai" as Api,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    contextWindow: 1000000,
    maxTokens: 65536,
  },
};

export function buildDynamicModel(
  modelId: string,
  provider: string,
): Model<Api> | null {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) return null;
  return {
    id: modelId,
    name: modelId,
    api: defaults.api,
    provider: provider as Model<Api>["provider"],
    baseUrl: defaults.baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}
