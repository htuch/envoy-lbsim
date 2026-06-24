/**
 * TypeScript loader for the Wasm LB module.
 *
 * Today this loads the EDF smoke brick (proving the toolchain). Track A grows
 * the Embind surface into the full {@link LbModule} from `@elbsim/protocol`
 * (`createLb` / `updateHosts` / `chooseHost` / `inspect`) and this loader returns
 * a conforming object. The artifact is an Emscripten ES module built by the
 * package Makefile to `build/edf_smoke.mjs`; the path is resolved at call time so
 * consumers do not need it present until they actually load the LB.
 */

/** Minimal Embind vector surface Emscripten generates for register_vector. */
export interface EmbindVector<T> {
  push_back(value: T): void;
  size(): number;
  get(index: number): T;
  delete(): void;
}

/** Shape of the current smoke module (superseded by the full ABI in Track A). */
export interface EdfSmokeModule {
  VectorDouble: new () => EmbindVector<number>;
  VectorInt: new () => EmbindVector<number>;
  edfPickCounts(weights: EmbindVector<number>, picks: number): EmbindVector<number>;
}

export type EdfSmokeFactory = () => Promise<EdfSmokeModule>;

/** Relative path (from this file) to the built Emscripten ES module. */
export const ARTIFACT_URL = new URL('../build/edf_smoke.mjs', import.meta.url);

/**
 * Load the compiled module. Throws a clear error if it has not been built yet
 * (run `pnpm --filter @elbsim/wasm-lb build`, which needs an activated emsdk).
 */
export async function loadEdfSmoke(): Promise<EdfSmokeModule> {
  let factory: EdfSmokeFactory;
  try {
    ({ default: factory } = (await import(ARTIFACT_URL.href)) as { default: EdfSmokeFactory });
  } catch (cause) {
    throw new Error(
      'wasm-lb artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk)',
      { cause },
    );
  }
  return factory();
}
