import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
  type ExtensionFactory,
  type ExtensionUIContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vite-plus/test";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { ModelConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { RuntimeCredentials } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/runtime-credentials.js";
import piCpt from "../src/index.ts";

export const conversation: Model<string> = {
  id: "conversation",
  name: "Offline conversation",
  api: "pi-cpt-offline",
  provider: "pi-cpt-offline",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 8192,
};
export const summary = { ...conversation, id: "summary", name: "Offline summary" };

export const reply = (
  model: Model<string>,
  content: AssistantMessage["content"],
  totalTokens: number,
): AssistantMessage => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content,
  stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  timestamp: 1,
  usage: {
    input: totalTokens - 20,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  },
});

// Pi 1.0.1's public ModelRuntime.create() installs ambient built-in providers.
// This test-only constructor adapter supplies ONLY our provider, in-memory stores,
// and an empty ModelConfig. All routing, auth, streaming and session code stays real.
// These installed internal APIs (including the inline extension loader) must be
// rechecked when changing the pinned host version; production uses public APIs only.
const OfflineModelRuntime = ModelRuntime as unknown as new (
  credentials: RuntimeCredentials,
  config: ModelConfig,
  modelsPath: undefined,
  modelsStore: InMemoryModelsStore,
  providers: Provider[],
  modelNetworkEnabled: boolean,
) => ModelRuntime;

export async function createHost(observe: ExtensionFactory = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cpt-host-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  // Fail closed if a future host change accidentally attempts network discovery.
  const fetch = vi.fn(() => {
    throw new Error("Network access is forbidden in offline host tests");
  });
  vi.stubGlobal("fetch", fetch);
  const cleanup = async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await writeFile(
      join(dir, "pi-cpt.json"),
      JSON.stringify({ provider: summary.provider, model: summary.id }),
    );
    const replies: AssistantMessage[] = [];
    const requests: { model: Model<string>; context: TranscriptContext }[] = [];
    const stream = (model: Model<string>, context: TranscriptContext) => {
      requests.push({ model, context: structuredClone(context) });
      const message = replies.shift();
      if (!message || message.model !== model.id) {
        throw new Error(`Unexpected offline request for ${model.id}`);
      }
      const result = createAssistantMessageEventStream();
      // These regressions concern finalized messages, so no intermediate deltas
      // are needed. The real agent consumes start and the terminal snapshot.
      result.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        result.push({ type: "error", reason: message.stopReason, error: message });
      } else if (message.stopReason === "pending") {
        throw new Error("Offline replies must be finalized");
      } else {
        result.push({ type: "done", reason: message.stopReason, message });
      }
      result.end(message);
      return result;
    };
    const provider: Provider = {
      id: conversation.provider,
      name: "Offline fixture",
      auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {} }) } },
      getModels: () => [conversation, summary],
      stream,
      streamSimple: stream,
    };
    const modelRuntime = new OfflineModelRuntime(
      new RuntimeCredentials(new InMemoryCredentialStore()),
      await ModelConfig.load(undefined),
      undefined,
      new InMemoryModelsStore(),
      [provider],
      false,
    );
    await modelRuntime.refresh({ allowNetwork: false });
    const runtime = createExtensionRuntime();
    const eventBus = createEventBus();
    const extensions = await Promise.all(
      [piCpt, observe].map((factory, index) =>
        loadExtensionFromFactory(factory, dir, eventBus, runtime, `<offline-${index}>`),
      ),
    );
    // Explicit resources avoid all user/project discovery, including global instructions.
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions, errors: [], runtime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Offline regression fixture.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
        retry: { enabled: false },
        cacheWarming: "off",
      }),
      model: conversation,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      noTools: "builtin",
    });
    const ui = {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: vi.fn<ExtensionUIContext["setStatus"]>(),
      notify: vi.fn<ExtensionUIContext["notify"]>(),
    };
    const errors: ExtensionError[] = [];
    try {
      await session.bindExtensions({
        mode: "tui",
        // Only the two UI methods used by pi-cpt are supplied; unexpected UI use fails.
        uiContext: ui as unknown as ExtensionUIContext,
        onError: (error) => errors.push(error),
      });
    } catch (error) {
      session.dispose();
      throw error;
    }
    return {
      session,
      manager,
      ui,
      errors,
      replies,
      requests,
      fetch,
      status: () => ui.setStatus.mock.lastCall?.[1],
      close: async () => {
        session.dispose();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
