import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
  plugins: [
    // NestJS resolves class-typed constructor parameters from `design:paramtypes`,
    // which only exists when the compiler emits decorator metadata. Vitest's
    // default esbuild transform does NOT implement emitDecoratorMetadata, so
    // every class-injected dependency arrives as `undefined` and DI fails in a
    // thoroughly confusing way. SWC does implement it. The production build uses
    // tsc and was never affected.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true, legacyDecorator: true },
      },
    }),
  ],
});
