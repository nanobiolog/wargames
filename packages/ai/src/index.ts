export { AiOpponent, makeAdvisor } from './opponent.ts';
export type { AiHost, OpponentOptions } from './opponent.ts';
export { RuleBrain } from './rules.ts';
export { makeProvider, loadConfig, DEFAULT_MODELS, MODEL_MENU, describeAiError, isNetworkError } from './providers.ts';
export type { LlmProvider, AiConfig } from './providers.ts';
export { GAME_TOOLS, toolCallToCommand } from './tools.ts';
export { situationReport } from './situation.ts';
export { opponentSystemPrompt, advisorSystemPrompt } from './situation.ts';
