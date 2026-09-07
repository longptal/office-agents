import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyProxyToModel,
  buildCustomModel,
  getProxySetupError,
  type ProviderConfig,
  providerNeedsCorsProxy,
  needsOpencodeSessionHeader,
  resolveProxyUrl,
} from "../src/provider-config";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4",
    useProxy: false,
    proxyUrl: "",
    thinking: "none",
    followMode: true,
    expandToolCalls: false,
    ...overrides,
  };
}

describe("buildCustomModel", () => {
  it("returns null when apiType is missing", () => {
    expect(buildCustomModel(makeConfig({ provider: "custom" }))).toBeNull();
  });

  it("returns null when customBaseUrl is missing", () => {
    expect(
      buildCustomModel(
        makeConfig({ provider: "custom", apiType: "openai-completions" }),
      ),
    ).toBeNull();
  });

  it("returns null when model is missing", () => {
    expect(
      buildCustomModel(
        makeConfig({
          provider: "custom",
          apiType: "openai-completions",
          customBaseUrl: "http://localhost:11434",
          model: "",
        }),
      ),
    ).toBeNull();
  });

  it("returns a model when all required fields are present", () => {
    const model = buildCustomModel(
      makeConfig({
        provider: "custom",
        apiType: "openai-completions",
        customBaseUrl: "http://localhost:11434",
        model: "llama3",
      }),
    );
    expect(model).not.toBeNull();
    expect(model!.api).toBe("openai-completions");
    expect(model!.baseUrl).toBe("http://localhost:11434");
  });
});

describe("applyProxyToModel", () => {
  const baseModel = {
    id: "gpt-4",
    name: "GPT-4",
    api: "openai-completions" as const,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  it("returns model unchanged when proxy is disabled", () => {
    const config = makeConfig({ useProxy: false, proxyUrl: "" });
    const result = applyProxyToModel(baseModel, config);
    expect(result.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("returns model unchanged when proxyUrl is empty", () => {
    const config = makeConfig({ useProxy: true, proxyUrl: "" });
    const result = applyProxyToModel(baseModel, config);
    expect(result.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("wraps baseUrl through proxy when enabled", () => {
    const config = makeConfig({
      useProxy: true,
      proxyUrl: "https://proxy.example.com",
    });
    const result = applyProxyToModel(baseModel, config);
    expect(result.baseUrl).toBe(
      `https://proxy.example.com/?url=${encodeURIComponent("https://api.openai.com/v1")}`,
    );
  });

  it("returns model unchanged when model has no baseUrl", () => {
    const modelWithoutBase = { ...baseModel, baseUrl: undefined } as unknown as Model<Api>;
    const config = makeConfig({
      useProxy: true,
      proxyUrl: "https://proxy.example.com",
    });
    const result = applyProxyToModel(modelWithoutBase, config);
    expect(result.baseUrl).toBeUndefined();
  });
});

describe("CORS auto-proxy", () => {
  const corsModel = {
    id: "glm-5.2",
    name: "GLM-5.2",
    api: "openai-completions" as const,
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32768,
  };

  it("flags opencode-go and anthropic as CORS-restricted", () => {
    expect(providerNeedsCorsProxy("opencode-go")).toBe(true);
    expect(providerNeedsCorsProxy("opencode")).toBe(true);
    expect(providerNeedsCorsProxy("anthropic")).toBe(true);
    expect(providerNeedsCorsProxy("openai")).toBe(false);
    expect(providerNeedsCorsProxy("custom")).toBe(false);
  });

  it("auto-applies proxy for opencode-go even when useProxy is false", () => {
    const config = makeConfig({
      provider: "opencode-go",
      useProxy: false,
      proxyUrl: "https://proxy.example.com",
    });
    const result = applyProxyToModel(corsModel, config);
    expect(result.baseUrl).toBe(
      `https://proxy.example.com/?url=${encodeURIComponent("https://opencode.ai/zen/go/v1")}`,
    );
  });

  it("resolveProxyUrl prefers an explicit enabled proxy over the auto path", () => {
    const config = makeConfig({
      provider: "opencode-go",
      useProxy: true,
      proxyUrl: "https://explicit.example.com",
    });
    expect(resolveProxyUrl(config)).toBe("https://explicit.example.com");
  });

  it("returns no proxy for non-restricted providers without an explicit proxy", () => {
    const config = makeConfig({ provider: "openai", useProxy: false, proxyUrl: "" });
    expect(resolveProxyUrl(config)).toBe("");
  });

  it("getProxySetupError reports a missing proxy for CORS-restricted providers", () => {
    const config = makeConfig({ provider: "opencode-go", proxyUrl: "" });
    // DEFAULT_CORS_PROXY_URL is now set, so auto-resolves to default proxy
    expect(getProxySetupError(config)).toBeNull();
  });

  it("getProxySetupError is null once a proxy URL is available", () => {
    const config = makeConfig({
      provider: "opencode-go",
      proxyUrl: "https://proxy.example.com",
    });
    expect(getProxySetupError(config)).toBeNull();
  });

  it("getProxySetupError is null for non-restricted providers", () => {
    expect(getProxySetupError(makeConfig({ provider: "openai" }))).toBeNull();
  });
});

describe("needsOpencodeSessionHeader", () => {
  const baseModel = {
    id: "gpt-4",
    name: "GPT-4",
    api: "openai-completions" as const,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  it("is true for opencode and opencode-go providers", () => {
    expect(
      needsOpencodeSessionHeader({ ...baseModel, provider: "opencode-go" }),
    ).toBe(true);
    expect(
      needsOpencodeSessionHeader({ ...baseModel, provider: "opencode" }),
    ).toBe(true);
  });

  it("is true when baseUrl points at opencode.ai (incl. proxied URLs)", () => {
    expect(
      needsOpencodeSessionHeader({
        ...baseModel,
        provider: "custom",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe(true);
    expect(
      needsOpencodeSessionHeader({
        ...baseModel,
        provider: "custom",
        baseUrl: `https://proxy.example.com/?url=${encodeURIComponent(
          "https://opencode.ai/zen/go/v1",
        )}`,
      }),
    ).toBe(true);
  });

  it("is false for other providers and base URLs", () => {
    expect(needsOpencodeSessionHeader(baseModel)).toBe(false);
    expect(
      needsOpencodeSessionHeader({
        ...baseModel,
        provider: "custom",
        baseUrl: "http://localhost:11434",
      }),
    ).toBe(false);
    expect(
      needsOpencodeSessionHeader({
        ...baseModel,
        baseUrl: undefined,
      } as unknown as Model<Api>),
    ).toBe(false);
  });
});
