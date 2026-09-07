import {
  Agent,
  type AgentEvent,
  type ThinkingLevel as AgentThinkingLevel,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  getModel,
  getModels,
  getProviders,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import type { AgentContext, StorageNamespace } from "./context";
import {
  agentMessagesToChatMessages,
  type ChatMessage,
  deriveStats,
  extractPartsFromAssistantMessage,
  generateId,
  type SessionStats,
} from "./message-utils";
import {
  loadOAuthCredentials,
  refreshOAuthToken,
  saveOAuthCredentials,
} from "./oauth";
import {
  applyProxyToModel,
  buildCustomModel,
  buildDynamicModel,
  fetchModelsFromProvider,
  getProxySetupError,
  isModelFree,
  loadCachedModels,
  loadSavedConfig,
  needsOpencodeSessionHeader,
  type ProviderConfig,
  resolveProxyUrl,
  saveCachedModels,
  saveConfig,
  supportsDynamicModels,
  type ThinkingLevel,
} from "./provider-config";
import {
  addSkill,
  getInstalledSkills,
  removeSkill,
  type SkillMeta,
  syncSkillsToVfs,
} from "./skills";
import {
  type ChatSession,
  createSession,
  deleteSession,
  getOrCreateCurrentSession,
  getSession,
  listSessions,
  loadVfsFiles,
  saveSession,
  saveVfsFiles,
} from "./storage";
import type { CustomCommandsResult } from "./vfs/custom-commands";

export interface RuntimeAdapter {
  tools: AgentTool[] | ((ctx: AgentContext) => AgentTool[]);
  buildSystemPrompt: (skills: SkillMeta[], commandSnippets: string[]) => string;
  getDocumentId: () => Promise<string>;
  getDocumentMetadata?: () => Promise<{
    metadata: object;
    nameMap?: Record<number, string>;
  } | null>;
  onToolResult?: (toolCallId: string, result: string, isError: boolean) => void;
  metadataTag?: string;
  staticFiles?: Record<string, string>;
  customCommands?: (ns: StorageNamespace) => CustomCommandsResult;
  storageNamespace?: Partial<StorageNamespace>;
}

export interface UploadedFile {
  name: string;
  size: number;
}

export interface RuntimeState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  providerConfig: ProviderConfig | null;
  sessionStats: SessionStats;
  currentSession: ChatSession | null;
  sessions: ChatSession[];
  nameMap: Record<number, string>;
  uploads: UploadedFile[];
  isUploading: boolean;
  skills: SkillMeta[];
  vfsInvalidatedAt: number;
}

type StateListener = (state: RuntimeState) => void;

const INITIAL_STATS: SessionStats = { ...deriveStats([]), contextWindow: 0 };

function thinkingLevelToAgent(level: ThinkingLevel): AgentThinkingLevel {
  return level === "none" ? "off" : level;
}

export class AgentRuntime {
  readonly context: AgentContext;

  private agent: Agent | null = null;
  private config: ProviderConfig | null = null;
  private pendingConfig: ProviderConfig | null = null;
  private streamingMessageId: string | null = null;
  private isStreaming = false;
  private documentId: string | null = null;
  private currentSessionId: string | null = null;
  private sessionLoaded = false;
  private followMode = true;
  private skills: SkillMeta[] = [];

  private adapter: RuntimeAdapter;
  private listeners: Set<StateListener> = new Set();
  private state: RuntimeState;

  private get ns(): StorageNamespace {
    return this.context.namespace;
  }

  private get tools(): AgentTool[] {
    return typeof this.adapter.tools === "function"
      ? this.adapter.tools(this.context)
      : this.adapter.tools;
  }

  constructor(adapter: RuntimeAdapter, context: AgentContext) {
    this.adapter = adapter;
    this.context = context;

    const saved = loadSavedConfig(this.ns);
    const isFree =
      saved?.provider &&
      saved?.model &&
      isModelFree(saved.provider, saved.model);
    const validConfig =
      saved?.provider && saved?.model && (saved?.apiKey || isFree)
        ? saved
        : null;
    this.followMode = validConfig?.followMode ?? true;
    this.state = {
      messages: [],
      isStreaming: false,
      error: null,
      providerConfig: validConfig,
      sessionStats: INITIAL_STATS,
      currentSession: null,
      sessions: [],
      nameMap: {},
      uploads: [],
      isUploading: false,
      skills: [],
      vfsInvalidatedAt: 0,
    };
  }

  getState(): RuntimeState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private update(partial: Partial<RuntimeState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private bumpVfs() {
    this.update({ vfsInvalidatedAt: Date.now() });
  }

  private updateMessages(
    updater: (messages: ChatMessage[]) => ChatMessage[],
    extra?: Partial<RuntimeState>,
  ) {
    this.state = {
      ...this.state,
      messages: updater(this.state.messages),
      ...extra,
    };
    this.emit();
  }

  setAdapter(adapter: RuntimeAdapter) {
    this.adapter = adapter;
  }

  getAvailableProviders(): string[] {
    return getProviders();
  }

  getModelsForProvider(provider: string): Model<Api>[] {
    try {
      return (getModels as (p: string) => Model<Api>[])(provider);
    } catch {
      return [];
    }
  }

  getDynamicModelsForProvider(provider: string): Model<Api>[] {
    const cached = loadCachedModels(this.ns, provider);
    if (!cached) return [];
    const staticModels = this.getModelsForProvider(provider);
    const staticIds = new Set(staticModels.map((m) => m.id));
    const dynamic: Model<Api>[] = [];
    for (const id of cached.ids) {
      if (staticIds.has(id)) continue;
      const model = buildDynamicModel(id, provider);
      if (model) dynamic.push(model);
    }
    return dynamic;
  }

  async refreshModels(): Promise<Model<Api>[]> {
    const config = this.config ?? this.state.providerConfig;
    if (!config || !supportsDynamicModels(config.provider)) {
      return this.getModelsForProvider(config?.provider || "");
    }
    const apiKey = await this.getActiveApiKey(config);
    if (!apiKey) return this.getModelsForProvider(config.provider);

    const proxyUrl = resolveProxyUrl(config);
    try {
      const ids = await fetchModelsFromProvider(
        config.provider,
        apiKey,
        proxyUrl,
      );
      saveCachedModels(this.ns, config.provider, ids);
      const staticModels = this.getModelsForProvider(config.provider);
      const staticIds = new Set(staticModels.map((m) => m.id));
      const merged = [...staticModels];
      for (const id of ids) {
        if (staticIds.has(id)) continue;
        const model = buildDynamicModel(id, config.provider);
        if (model) merged.push(model);
      }
      return merged;
    } catch {
      return this.getModelsForProvider(config.provider);
    }
  }

  private async getActiveApiKey(config: ProviderConfig): Promise<string> {
    if (config.authMethod !== "oauth") {
      return config.apiKey;
    }
    const creds = loadOAuthCredentials(this.ns, config.provider);
    if (!creds) return config.apiKey;
    if (Date.now() < creds.expires) {
      return creds.access;
    }
    const refreshed = await refreshOAuthToken(
      config.provider,
      creds.refresh,
      config.proxyUrl,
      config.useProxy,
    );
    saveOAuthCredentials(this.ns, config.provider, refreshed);
    return refreshed.access;
  }

  private getOpencodeSessionId(): string {
    if (this.currentSessionId) return this.currentSessionId;
    const key = `${this.ns.localStoragePrefix}-opencode-session`;
    let fallback = localStorage.getItem(key);
    if (!fallback) {
      fallback = generateId();
      localStorage.setItem(key, fallback);
    }
    return fallback;
  }

  private handleAgentEvent = (event: AgentEvent) => {
    console.log("[Runtime] Agent event:", event.type, event);
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          const id = generateId();
          this.streamingMessageId = id;
          const parts = extractPartsFromAssistantMessage(event.message);
          const chatMessage: ChatMessage = {
            id,
            role: "assistant",
            parts,
            timestamp: event.message.timestamp,
          };
          this.updateMessages((msgs) => [...msgs, chatMessage]);
        }
        break;
      }
      case "message_update": {
        if (event.message.role === "assistant" && this.streamingMessageId) {
          const streamId = this.streamingMessageId;
          this.updateMessages((msgs) => {
            const messages = [...msgs];
            const idx = messages.findIndex((m) => m.id === streamId);
            if (idx !== -1) {
              const parts = extractPartsFromAssistantMessage(
                event.message,
                messages[idx].parts,
              );
              messages[idx] = { ...messages[idx], parts };
            }
            return messages;
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") {
          const assistantMsg = event.message as AssistantMessage;
          const isStreamInterruption =
            assistantMsg.stopReason === "error" &&
            Boolean(
              assistantMsg.errorMessage?.includes("finish_reason") ||
                assistantMsg.errorMessage?.includes("stream ended"),
            );
          const isError =
            (assistantMsg.stopReason === "error" && !isStreamInterruption) ||
            assistantMsg.stopReason === "aborted";
          const streamId = this.streamingMessageId;

          let preservedPartial = false;

          this.updateMessages(
            (msgs) => {
              const messages = [...msgs];
              const idx = messages.findIndex((m) => m.id === streamId);

              if (isError) {
                if (idx !== -1) {
                  messages.splice(idx, 1);
                }
              } else if (isStreamInterruption && idx !== -1) {
                const existingParts = messages[idx].parts;
                const hasAnyContent = existingParts.some(
                  (p) =>
                    (p.type === "text" && p.text && p.text.trim()) ||
                    (p.type === "thinking" && p.thinking && p.thinking.trim()),
                );
                if (hasAnyContent) {
                  const parts = [...existingParts];
                  let lastTextIdx = -1;
                  for (let i = parts.length - 1; i >= 0; i--) {
                    if (parts[i].type === "text") {
                      lastTextIdx = i;
                      break;
                    }
                  }
                  if (lastTextIdx !== -1) {
                    const tp = parts[lastTextIdx];
                    if (tp.type === "text") {
                      parts[lastTextIdx] = {
                        ...tp,
                        text:
                          tp.text +
                          "\n\n⚠️ Stream interrupted — partial response shown.",
                      };
                    }
                  } else {
                    parts.push({
                      type: "text" as const,
                      text: "⚠️ Stream interrupted — partial response shown.",
                    });
                  }
                  messages[idx] = { ...messages[idx], parts };
                  preservedPartial = true;
                } else {
                  messages.splice(idx, 1);
                }
              } else if (idx !== -1) {
                const parts = extractPartsFromAssistantMessage(
                  event.message,
                  messages[idx].parts,
                );
                messages[idx] = { ...messages[idx], parts };
              }
              return messages;
            },
            {
              sessionStats:
                isError || isStreamInterruption
                  ? this.state.sessionStats
                  : {
                      ...deriveStats(this.agent?.state.messages ?? []),
                      contextWindow: this.state.sessionStats.contextWindow,
                    },
            },
          );

          if (isError || (isStreamInterruption && !preservedPartial)) {
            this.update({
              error: assistantMsg.errorMessage || "Request failed",
            });
          }

          this.streamingMessageId = null;
        }
        break;
      }
      case "tool_execution_start": {
        this.updateMessages((msgs) => {
          const messages = [...msgs];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex(
              (p) => p.type === "toolCall" && p.id === event.toolCallId,
            );
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                parts[partIdx] = { ...part, status: "running" };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return messages;
        });
        break;
      }
      case "tool_execution_update": {
        this.updateMessages((msgs) => {
          const messages = [...msgs];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex(
              (p) => p.type === "toolCall" && p.id === event.toolCallId,
            );
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                let partialText: string;
                if (typeof event.partialResult === "string") {
                  partialText = event.partialResult;
                } else if (
                  event.partialResult?.content &&
                  Array.isArray(event.partialResult.content)
                ) {
                  partialText = event.partialResult.content
                    .filter((c: { type: string }) => c.type === "text")
                    .map((c: { text: string }) => c.text)
                    .join("\n");
                } else {
                  partialText = JSON.stringify(event.partialResult, null, 2);
                }
                parts[partIdx] = { ...part, result: partialText };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return messages;
        });
        break;
      }
      case "tool_execution_end": {
        let resultText: string;
        let resultImages: { data: string; mimeType: string }[] | undefined;
        if (typeof event.result === "string") {
          resultText = event.result;
        } else if (
          event.result?.content &&
          Array.isArray(event.result.content)
        ) {
          resultText = event.result.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { text: string }) => c.text)
            .join("\n");
          const images = event.result.content
            .filter((c: { type: string }) => c.type === "image")
            .map((c: { data: string; mimeType: string }) => ({
              data: c.data,
              mimeType: c.mimeType,
            }));
          if (images.length > 0) resultImages = images;
        } else {
          resultText = JSON.stringify(event.result, null, 2);
        }

        if (!event.isError && this.followMode) {
          this.adapter.onToolResult?.(event.toolCallId, resultText, false);
        }

        this.updateMessages((msgs) => {
          const messages = [...msgs];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const partIdx = msg.parts.findIndex(
              (p) => p.type === "toolCall" && p.id === event.toolCallId,
            );
            if (partIdx !== -1) {
              const parts = [...msg.parts];
              const part = parts[partIdx];
              if (part.type === "toolCall") {
                parts[partIdx] = {
                  ...part,
                  status: event.isError ? "error" : "complete",
                  result: resultText,
                  images: resultImages,
                };
                messages[i] = { ...msg, parts };
              }
              break;
            }
          }
          return messages;
        });
        break;
      }
      case "agent_end": {
        this.isStreaming = false;
        this.streamingMessageId = null;
        this.update({ isStreaming: false });
        this.onStreamingEnd();
        break;
      }
    }
  };

  applyConfig(config: ProviderConfig) {
    let contextWindow = 0;
    let baseModel: Model<Api>;
    if (config.provider === "custom") {
      const custom = buildCustomModel(config);
      if (!custom) return;
      baseModel = custom;
    } else {
      try {
        baseModel = (getModel as (p: string, m: string) => Model<Api>)(
          config.provider,
          config.model,
        );
      } catch {
        const dynamic = buildDynamicModel(config.model, config.provider);
        if (!dynamic) return;
        baseModel = dynamic;
      }
    }
    contextWindow = baseModel.contextWindow;
    this.config = config;

    const proxyError = getProxySetupError(config);
    if (this.agent) {
      this.agent.abort();
    }

    if (proxyError) {
      this.agent = null;
      this.pendingConfig = null;
      this.update({
        providerConfig: config,
        error: proxyError,
        sessionStats: {
          ...this.state.sessionStats,
          contextWindow,
        },
      });
      return;
    }

    const proxiedModel = applyProxyToModel(baseModel, config);
    const existingMessages = this.agent?.state.messages ?? [];

    const systemPrompt = this.adapter.buildSystemPrompt(
      this.skills,
      this.context.commandSnippets,
    );

    const agent = new Agent({
      initialState: {
        model: proxiedModel,
        systemPrompt,
        thinkingLevel: thinkingLevelToAgent(config.thinking),
        tools: this.tools,
        messages: existingMessages,
      },
      streamFn: async (model, context, options) => {
        const cfg = this.config ?? config;
        let apiKey = await this.getActiveApiKey(cfg);
        if (!apiKey) {
          const { isModelFree, shouldRequireApiKey } = await import(
            "./provider-config"
          );
          if (shouldRequireApiKey(model.provider as string, model.id)) {
            throw new Error(
              `API key required for ${model.id}. This model is not free — please enter your API key in Settings, or select a free model (· free) to use without a key.`,
            );
          }
          if (isModelFree(model.provider as string, model.id)) {
            apiKey = "__free_no_key__";
          }
        }
        const extra: {
          sessionId?: string;
          headers?: Record<string, string | null>;
        } = {};
        if (needsOpencodeSessionHeader(model)) {
          const sessionId = options?.sessionId ?? this.getOpencodeSessionId();
          extra.sessionId = sessionId;
          extra.headers = {
            ...(options?.headers ?? {}),
            "x-opencode-session": sessionId,
          };
        }
        return streamSimple(model, context, {
          ...options,
          apiKey,
          ...extra,
        });
      },
    });
    this.agent = agent;
    agent.subscribe(this.handleAgentEvent);
    this.pendingConfig = null;
    this.followMode = config.followMode ?? true;

    this.update({
      providerConfig: config,
      error: null,
      sessionStats: {
        ...this.state.sessionStats,
        contextWindow,
      },
    });
  }

  setProviderConfig(config: ProviderConfig) {
    if (this.isStreaming) {
      this.pendingConfig = config;
      this.update({ providerConfig: config });
      return;
    }
    this.applyConfig(config);
  }

  abort() {
    this.agent?.abort();
    this.isStreaming = false;
    this.update({ isStreaming: false });
  }

  async sendMessage(content: string, attachments?: string[]) {
    if (this.pendingConfig) {
      this.applyConfig(this.pendingConfig);
    }
    const agent = this.agent;
    if (!agent || !this.state.providerConfig) {
      this.update({
        error: this.state.error || "Please configure your API key first",
      });
      return;
    }

    const userMessage: ChatMessage = {
      id: generateId(),
      role: "user",
      parts: [{ type: "text", text: content }],
      timestamp: Date.now(),
    };

    this.isStreaming = true;
    this.update({
      messages: [...this.state.messages, userMessage],
      isStreaming: true,
      error: null,
    });

    try {
      let promptContent = content;

      if (this.adapter.getDocumentMetadata) {
        try {
          const meta = await this.adapter.getDocumentMetadata();
          if (meta) {
            const tag = this.adapter.metadataTag || "doc_context";
            promptContent = `<${tag}>\n${JSON.stringify(meta.metadata, null, 2)}\n</${tag}>\n\n${content}`;
            if (meta.nameMap) {
              this.update({ nameMap: meta.nameMap });
            }
          }
        } catch (err) {
          console.error("[Runtime] Failed to get document metadata:", err);
        }
      }

      if (attachments && attachments.length > 0) {
        const paths = attachments
          .map((name) => `/home/user/uploads/${name}`)
          .join("\n");
        promptContent = `<attachments>\n${paths}\n</attachments>\n\n${promptContent}`;
      }

      await agent.prompt(promptContent);
    } catch (err) {
      console.error("[Runtime] sendMessage error:", err);
      this.isStreaming = false;
      this.update({
        isStreaming: false,
        error: err instanceof Error ? err.message : "An error occurred",
      });
    }
  }

  clearMessages() {
    this.abort();
    this.agent?.reset();
    this.context.reset();
    if (this.currentSessionId) {
      Promise.all([
        saveSession(this.ns, this.currentSessionId, []),
        saveVfsFiles(this.ns, this.currentSessionId, []),
      ]).catch(console.error);
    }
    this.update({
      messages: [],
      error: null,
      sessionStats: INITIAL_STATS,
      uploads: [],
    });
  }

  private async refreshSessions() {
    if (!this.documentId) return;
    const sessions = await listSessions(this.ns, this.documentId);
    this.update({ sessions });
  }

  async newSession() {
    if (!this.documentId) return;
    if (this.isStreaming) return;
    try {
      this.agent?.reset();
      this.context.reset();
      const session = await createSession(this.ns, this.documentId);
      this.currentSessionId = session.id;
      await this.refreshSessions();
      this.update({
        messages: [],
        currentSession: session,
        error: null,
        sessionStats: INITIAL_STATS,
        uploads: [],
      });
    } catch (err) {
      console.error("[Runtime] Failed to create session:", err);
    }
  }

  async switchSession(sessionId: string) {
    if (this.currentSessionId === sessionId) return;
    if (this.isStreaming) return;
    this.agent?.reset();
    try {
      const [session, vfsFiles] = await Promise.all([
        getSession(this.ns, sessionId),
        loadVfsFiles(this.ns, sessionId),
      ]);
      if (!session) return;
      await this.context.restoreVfs(vfsFiles);
      this.currentSessionId = session.id;

      if (session.agentMessages.length > 0 && this.agent) {
        this.agent.state.messages = session.agentMessages;
      }

      const uploadNames = await this.context.listUploads();
      const stats = deriveStats(session.agentMessages);
      this.update({
        messages: agentMessagesToChatMessages(
          session.agentMessages,
          this.adapter.metadataTag,
        ),
        currentSession: session,
        error: null,
        sessionStats: {
          ...stats,
          contextWindow: this.state.sessionStats.contextWindow,
        },
        uploads: uploadNames.map((name) => ({ name, size: 0 })),
      });
      await this.refreshNameMap();
    } catch (err) {
      console.error("[Runtime] Failed to switch session:", err);
    }
  }

  async deleteCurrentSession() {
    if (!this.currentSessionId || !this.documentId) return;
    if (this.isStreaming) return;
    this.agent?.reset();
    const deletedId = this.currentSessionId;
    await Promise.all([
      deleteSession(this.ns, deletedId),
      saveVfsFiles(this.ns, deletedId, []),
    ]);
    const session = await getOrCreateCurrentSession(this.ns, this.documentId);
    this.currentSessionId = session.id;
    const vfsFiles = await loadVfsFiles(this.ns, session.id);
    await this.context.restoreVfs(vfsFiles);

    if (session.agentMessages.length > 0 && this.agent) {
      this.agent.state.messages = session.agentMessages;
    }

    await this.refreshSessions();
    const uploadNames = await this.context.listUploads();
    const stats = deriveStats(session.agentMessages);
    this.update({
      messages: agentMessagesToChatMessages(
        session.agentMessages,
        this.adapter.metadataTag,
      ),
      currentSession: session,
      error: null,
      sessionStats: {
        ...stats,
        contextWindow: this.state.sessionStats.contextWindow,
      },
      uploads: uploadNames.map((name) => ({ name, size: 0 })),
    });
  }

  private async onStreamingEnd() {
    if (!this.currentSessionId) return;
    const sessionId = this.currentSessionId;
    const agentMessages = this.agent?.state.messages ?? [];
    try {
      const vfsFiles = await this.context.snapshotVfs();
      await Promise.all([
        saveSession(this.ns, sessionId, agentMessages),
        saveVfsFiles(this.ns, sessionId, vfsFiles),
      ]);
      await this.refreshSessions();
      const updated = await getSession(this.ns, sessionId);
      if (updated) {
        this.update({ currentSession: updated });
      }
      this.bumpVfs();
    } catch (e) {
      console.error(e);
    }
  }

  async init() {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;

    try {
      // update staticFiles and customCommands jic any changes
      // happened between context init (on app mount) vs session init
      if (this.adapter.staticFiles) {
        await this.context.setStaticFiles(this.adapter.staticFiles);
      }
      if (this.adapter.customCommands) {
        this.context.setCustomCommands(this.adapter.customCommands);
      }

      const id = await this.adapter.getDocumentId();
      this.documentId = id;

      const skills = await getInstalledSkills(this.ns);
      this.skills = skills;
      await syncSkillsToVfs(this.ns, this.context);

      const saved = loadSavedConfig(this.ns);
      if (
        saved?.provider &&
        saved?.model &&
        (saved?.apiKey || isModelFree(saved.provider, saved.model))
      ) {
        this.applyConfig(saved);
      }

      const session = await getOrCreateCurrentSession(this.ns, id);
      this.currentSessionId = session.id;
      const [sessions, vfsFiles] = await Promise.all([
        listSessions(this.ns, id),
        loadVfsFiles(this.ns, session.id),
      ]);
      if (vfsFiles.length > 0) {
        await this.context.restoreVfs(vfsFiles);
      }

      if (session.agentMessages.length > 0 && this.agent) {
        this.agent.state.messages = session.agentMessages;
      }

      const uploadNames = await this.context.listUploads();
      const stats = deriveStats(session.agentMessages);
      this.update({
        messages: agentMessagesToChatMessages(
          session.agentMessages,
          this.adapter.metadataTag,
        ),
        currentSession: session,
        sessions,
        skills,
        sessionStats: {
          ...stats,
          contextWindow: this.state.sessionStats.contextWindow,
        },
        uploads: uploadNames.map((name) => ({ name, size: 0 })),
      });
      await this.refreshNameMap();
    } catch (err) {
      console.error("[Runtime] Failed to load session:", err);
    }
  }

  async uploadFiles(files: { name: string; size: number; data: Uint8Array }[]) {
    if (files.length === 0) return;
    this.update({ isUploading: true });
    try {
      for (const file of files) {
        await this.context.writeFile(file.name, file.data);
        const uploads = [...this.state.uploads];
        const exists = uploads.findIndex((u) => u.name === file.name);
        if (exists !== -1) {
          uploads[exists] = { name: file.name, size: file.size };
        } else {
          uploads.push({ name: file.name, size: file.size });
        }
        this.update({ uploads });
      }
      if (this.currentSessionId) {
        const snapshot = await this.context.snapshotVfs();
        await saveVfsFiles(this.ns, this.currentSessionId, snapshot);
      }
      this.bumpVfs();
    } catch (err) {
      console.error("Failed to upload file:", err);
    } finally {
      this.update({ isUploading: false });
    }
  }

  async removeUpload(name: string) {
    try {
      await this.context.deleteFile(name);
      this.update({
        uploads: this.state.uploads.filter((u) => u.name !== name),
      });
      if (this.currentSessionId) {
        const snapshot = await this.context.snapshotVfs();
        await saveVfsFiles(this.ns, this.currentSessionId, snapshot);
      }
      this.bumpVfs();
    } catch (err) {
      console.error("Failed to delete file:", err);
      this.update({
        uploads: this.state.uploads.filter((u) => u.name !== name),
      });
    }
  }

  private async refreshSkillsAndRebuildAgent() {
    this.skills = await getInstalledSkills(this.ns);
    this.update({ skills: this.skills });
    if (this.state.providerConfig) {
      this.applyConfig(this.state.providerConfig);
    }
  }

  async installSkill(inputs: { path: string; data: Uint8Array }[]) {
    if (inputs.length === 0) return;
    try {
      await addSkill(this.ns, this.context, inputs);
      await this.refreshSkillsAndRebuildAgent();
    } catch (err) {
      console.error("[Runtime] Failed to install skill:", err);
      this.update({
        error: err instanceof Error ? err.message : "Failed to install skill",
      });
    }
  }

  async uninstallSkill(name: string) {
    try {
      await removeSkill(this.ns, this.context, name);
      await this.refreshSkillsAndRebuildAgent();
    } catch (err) {
      console.error("[Runtime] Failed to uninstall skill:", err);
    }
  }

  toggleFollowMode() {
    if (!this.state.providerConfig) return;
    const newFollowMode = !this.state.providerConfig.followMode;
    this.followMode = newFollowMode;
    const newConfig = {
      ...this.state.providerConfig,
      followMode: newFollowMode,
    };
    saveConfig(this.ns, newConfig);
    this.update({ providerConfig: newConfig });
  }

  toggleExpandToolCalls() {
    if (!this.state.providerConfig) return;
    const newConfig = {
      ...this.state.providerConfig,
      expandToolCalls: !this.state.providerConfig.expandToolCalls,
    };
    saveConfig(this.ns, newConfig);
    this.update({ providerConfig: newConfig });
  }

  getName(id: number): string | undefined {
    return this.state.nameMap[id];
  }

  private async refreshNameMap() {
    if (!this.adapter.getDocumentMetadata) return;
    try {
      const meta = await this.adapter.getDocumentMetadata();
      if (meta?.nameMap) {
        this.update({ nameMap: meta.nameMap });
      }
    } catch (err) {
      console.error("[Runtime] Failed to refresh nameMap:", err);
    }
  }

  dispose() {
    this.agent?.abort();
    this.listeners.clear();
  }
}
