import { findResolvedModelRuntime, type Database } from "@meet/database";

import {
  OpenAICompatibleConversationAnalyzer,
  type ConversationAnalyzer,
} from "./analyzer.js";

export interface ConversationAnalyzerResolver {
  resolve(modelProfileId: string): Promise<ConversationAnalyzer>;
}

export class DatabaseConversationAnalyzerResolver implements ConversationAnalyzerResolver {
  constructor(
    private readonly db: Database,
    private readonly fetchFunction: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async resolve(modelProfileId: string): Promise<ConversationAnalyzer> {
    const runtime = await findResolvedModelRuntime(this.db, modelProfileId, {
      requireEnabled: false,
    });
    if (
      !runtime ||
      runtime.profile.kind !== "text" ||
      runtime.connection.adapter !== "openai_chat_completions" ||
      !runtime.connection.endpoint ||
      !runtime.connection.apiKey
    ) {
      throw new Error("Queued text model configuration is unavailable.");
    }
    return new OpenAICompatibleConversationAnalyzer({
      apiKey: runtime.connection.apiKey,
      baseUrl: runtime.connection.endpoint,
      model: runtime.profile.model,
      requestTimeoutMs: 60_000,
      compatibilityPreset:
        runtime.connection.compatibilityPreset === "dashscope"
          ? "dashscope"
          : "standard",
      fetchFunction: this.fetchFunction,
    });
  }
}
