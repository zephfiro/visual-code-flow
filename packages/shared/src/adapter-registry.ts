import type { LanguageAdapter } from './language-adapter.js';

/** Immutable language-to-adapter routing shared by hosts and tests. */
export class LanguageAdapterRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();
  readonly supportedLanguages: readonly string[];

  constructor(adapters: readonly LanguageAdapter[]) {
    for (const adapter of adapters) {
      for (const language of adapter.supportedLanguages) {
        if (!language || this.adapters.has(language)) {
          throw new Error(`Invalid or duplicate language registration: ${language}`);
        }
        this.adapters.set(language, adapter);
      }
    }
    this.supportedLanguages = Object.freeze([...this.adapters.keys()]);
  }

  get(languageId: string): LanguageAdapter | undefined {
    return this.adapters.get(languageId);
  }
}
