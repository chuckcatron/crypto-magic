/**
 * DI tokens live apart from the module that binds them.
 *
 * Declaring them in `persistence.module.ts` creates a cycle — the module
 * imports the repositories, and each repository imports the token back from the
 * module — which resolves to `undefined` at decoration time and fails DI with a
 * misleading "argument at index [0] is not available".
 */
export const DATABASE = Symbol('DATABASE');
