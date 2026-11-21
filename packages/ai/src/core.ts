// Runtime-neutral entry point (browsers, Cloudflare Workers): everything except the SDK-backed providers.
export { AiOpponent, makeAdvisor } from './opponent.ts';
export type { AiHost, OpponentOptions } from './opponent.ts';
export { RuleBrain } from './rules.ts';
export { describeAiError, isNetworkError } from './llm.ts';
export type { LlmProvider, LlmResult } from './llm.ts';
export { GAME_TOOLS, toolCallToCommand } from './tools.ts';
export type { ToolCall, ToolSpec } from './tools.ts';
export { situationReport, opponentSystemPrompt, advisorSystemPrompt } from './situation.ts';
