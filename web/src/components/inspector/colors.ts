/**
 * Categorical color per backend index, used to tint Maglev slots and hash-ring
 * points so a backend's share is visually traceable across the structures.
 */
const PALETTE = [
  'hsl(222 65% 52%)',
  'hsl(150 60% 42%)',
  'hsl(38 92% 50%)',
  'hsl(280 55% 58%)',
  'hsl(0 72% 55%)',
  'hsl(190 65% 45%)',
  'hsl(330 60% 55%)',
  'hsl(96 50% 45%)',
  'hsl(255 60% 62%)',
  'hsl(20 80% 52%)',
] as const;

export function backendColor(index: number): string {
  // `index % length` is always a valid palette index; the assertion just
  // satisfies noUncheckedIndexedAccess without a dead fallback branch.
  return PALETTE[Math.abs(index) % PALETTE.length]!;
}
