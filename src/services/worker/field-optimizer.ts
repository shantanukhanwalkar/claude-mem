/**
 * Compatibility boundary for observation field optimization (#3800).
 *
 * Observation payloads must not trigger a second model request before the
 * observer sees them. `buildObservationPrompt` applies the deterministic size
 * bound, retaining the head and tail with an explicit elision marker.
 */

import { OBS_PROMPT_FIELD_MAX_CHARS } from '../../sdk/prompts.js';

/**
 * A single bounded model call: condense `text` to at most `budgetChars`.
 * Returns null when the provider cannot do it. Supplied by each provider so
 * this module stays free of provider wiring and is testable on its own.
 */
export type FieldCompressor = (text: string, budgetChars: number) => Promise<string | null>;

/** @deprecated Kept temporarily for callers compiled against this module. */
export const FIELD_OPTIMIZE_TIMEOUT_MS = 30_000;

/** @deprecated Field compression is no longer used by the observation path. */
export function buildFieldCompressionPrompt(text: string, budgetChars: number): string {
  return `Condense the tool payload below to under ${budgetChars} characters.

It is going into an observation record, so preserve everything that carries
signal: file paths, identifiers, commands, counts, error text, status codes, and
any concrete values a later reader would need. Drop repetition, boilerplate and
filler. Keep the original ordering.

Reply with the condensed payload only — no preamble, no commentary, no code
fences.

<payload>
${text}
</payload>`;
}

/**
 * Return a field unchanged so prompt construction can bound it locally.
 * The compressor argument remains temporarily for source compatibility.
 */
export async function optimizeField(
  value: unknown,
  compress: FieldCompressor,
  context: { sessionDbId: number; field: string; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
): Promise<unknown> {
  void compress;
  void context;
  void maxChars;
  return value;
}

/**
 * Preserve both payload fields for deterministic truncation in the final
 * observation prompt. The compressor argument remains for caller compatibility.
 */
export async function optimizeObservationFields(
  fields: { toolInput: unknown; toolOutput: unknown },
  compress: FieldCompressor,
  context: { sessionDbId: number; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
): Promise<{ toolInput: unknown; toolOutput: unknown }> {
  void compress;
  void context;
  void maxChars;
  return { toolInput: fields.toolInput, toolOutput: fields.toolOutput };
}
