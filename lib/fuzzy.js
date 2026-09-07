// lib/fuzzy.js
// Shared, dependency-free fuzzy matching helpers.
// Loaded before content-autofill.js in the same content-script world,
// so everything here is just available as globals (FuzzyMatch.*).

(function () {
  /**
   * Normalize a label/field name for comparison:
   * lowercase, strip punctuation/underscores/dashes, collapse whitespace,
   * drop common filler words that don't help matching.
   */
  function normalize(str) {
    if (!str) return "";
    return str
      .toLowerCase()
      .replace(/[_\-.:#]/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Classic Levenshtein edit distance. */
  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length,
      bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;

    let prevRow = new Array(bl + 1);
    let curRow = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prevRow[j] = j;

    for (let i = 1; i <= al; i++) {
      curRow[0] = i;
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curRow[j] = Math.min(
          prevRow[j] + 1, // deletion
          curRow[j - 1] + 1, // insertion
          prevRow[j - 1] + cost // substitution
        );
      }
      [prevRow, curRow] = [curRow, prevRow];
    }
    return prevRow[bl];
  }

  /** Similarity score in [0, 1]. 1 = identical, 0 = completely different. */
  function similarity(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;

    // Strong signal: one contains the other in full (e.g. "Order ID" in "Please enter your Order ID")
    if (na.includes(nb) || nb.includes(na)) {
      const shorter = Math.min(na.length, nb.length);
      const longer = Math.max(na.length, nb.length);
      return 0.85 + 0.15 * (shorter / longer); // 0.85 - 1.0
    }

    const dist = levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    return 1 - dist / maxLen;
  }

  /**
   * Given a form field label and a field definition ({label, aliases}),
   * return the best similarity score against the label OR any alias.
   */
  function bestScoreForDefinition(formLabel, definition) {
    const candidates = [definition.label, ...(definition.aliases || [])].filter(
      Boolean
    );
    let best = 0;
    for (const c of candidates) {
      const s = similarity(formLabel, c);
      if (s > best) best = s;
    }
    return best;
  }

  /**
   * Match a list of form labels against a list of field definitions.
   * Returns array of { formLabel, definition, score } for matches above threshold,
   * picking the single best definition per form label (no double-assigning a
   * definition to two fields unless scores are tied and both are very high).
   */
  function matchAll(formLabels, definitions, threshold = 0.72) {
    const results = [];
    const usedDefinitionIds = new Set();

    // Score every (formLabel, definition) pair, then greedily assign
    // highest-confidence pairs first so the best match wins ties.
    const pairs = [];
    for (const formLabel of formLabels) {
      for (const def of definitions) {
        const score = bestScoreForDefinition(formLabel, def);
        if (score >= threshold) {
          pairs.push({ formLabel, definition: def, score });
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    const usedLabels = new Set();
    for (const pair of pairs) {
      if (usedLabels.has(pair.formLabel)) continue;
      if (usedDefinitionIds.has(pair.definition.id)) continue;
      usedLabels.add(pair.formLabel);
      usedDefinitionIds.add(pair.definition.id);
      results.push(pair);
    }
    return results;
  }

  const api = { normalize, levenshtein, similarity, bestScoreForDefinition, matchAll };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    self.FuzzyMatch = api;
  }
})();
