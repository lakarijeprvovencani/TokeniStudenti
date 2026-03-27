import { jsonrepair } from 'jsonrepair';

/**
 * Parse model-produced tool `function.arguments` string into an object.
 * Handles markdown fences, common JSON malformations (jsonrepair fallback),
 * and truncated JSON from long write_file calls (manual key extraction).
 */
export function parseToolCallArguments(raw: string): Record<string, unknown> | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }

  const tryParse = (input: string): Record<string, unknown> | null => {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  };

  // 1. Try direct parse
  try {
    const ok = tryParse(s);
    if (ok) return ok;
  } catch {
    /* try repair */
  }

  // 2. Try jsonrepair
  try {
    const repaired = jsonrepair(s);
    const ok = tryParse(repaired);
    if (ok) return ok;
  } catch {
    /* try manual extraction */
  }

  // 3. Manual extraction fallback for truncated JSON.
  // When the model streams a large write_file call and it gets truncated,
  // the JSON is cut mid-string. We try to extract at least "path" and "content"
  // so the tool can execute (even with partial content) rather than failing completely.
  try {
    const result: Record<string, unknown> = {};
    // Extract simple string keys from truncated JSON like {"path": "foo.css", "content": "body { ...
    const keyPattern = /"(path|content|content_base64|old_text|new_text|query|url|command|pattern|recursive|orientation|count)":\s*"((?:[^"\\]|\\.)*)(?:"|$)/g;
    let match;
    while ((match = keyPattern.exec(s)) !== null) {
      const key = match[1];
      const val = match[2]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      result[key] = val;
    }

    // Also try to extract boolean/number values
    const boolPattern = /"(recursive)":\s*(true|false)/g;
    while ((match = boolPattern.exec(s)) !== null) {
      result[match[1]] = match[2] === 'true';
    }

    if (Object.keys(result).length > 0) {
      return result;
    }
  } catch {
    /* give up */
  }

  return null;
}
