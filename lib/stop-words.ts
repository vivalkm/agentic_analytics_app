/**
 * Shared stop-word set used by all keyword-matching modules
 * (metadata, query-matcher, metric-catalog, chart-detector, github-queries).
 *
 * Union of all words that were independently maintained across 5 files.
 */
export const STOP_WORDS = new Set([
  // Common articles/conjunctions/prepositions
  'the', 'and', 'for', 'from', 'with', 'that', 'this',
  // Question words / verbs commonly in user prompts
  'what', 'show', 'how', 'many', 'all', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'will', 'would',
  'could', 'should', 'may', 'can', 'its', 'our', 'their',
  'give', 'tell', 'about',
  // Time-related (not useful for keyword matching)
  'trend', 'daily', 'monthly', 'weekly', 'over', 'time',
  'last', 'past',
]);

/** Extract keywords from a lowercased question string, filtering stop words and short tokens. */
export function extractKeywords(questionLower: string): string[] {
  return questionLower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}
