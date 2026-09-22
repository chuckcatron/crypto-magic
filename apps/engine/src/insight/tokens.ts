/** DI tokens live apart from the modules that bind them — see persistence/tokens.ts. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const NEWS_PROVIDER = Symbol('NEWS_PROVIDER');
