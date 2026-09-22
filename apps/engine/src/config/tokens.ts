/** DI tokens live apart from the modules that bind them — see persistence/tokens.ts. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const RISK_LIMITS = Symbol('RISK_LIMITS');
export const STOP_CONFIG = Symbol('STOP_CONFIG');
export const STRATEGY_CONFIG = Symbol('STRATEGY_CONFIG');
