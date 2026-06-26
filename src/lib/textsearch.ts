// Boolean / keyword query parsing + full-text matching against the inverted
// index (public/data/textindex.json). Tokenization mirrors build_text_index.py.

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

type TextIndex = Record<string, number[]>;

let indexPromise: Promise<TextIndex> | null = null;

export function loadTextIndex(): Promise<TextIndex> {
  if (!indexPromise) {
    indexPromise = fetch(`${DATA_BASE}/textindex.json`).then((r) => r.json());
  }
  return indexPromise;
}

const TOKEN_RE = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length >= 2);
}

// ── Parsed query shape ────────────────────────────────────────────────────────

interface Item {
  kind: "term" | "phrase" | "wildcard";
  value: string;       // term/wildcard prefix
  tokens?: string[];   // for phrases
}

export interface ParsedQuery {
  hasOperators: boolean;
  requiredGroups: Item[][]; // AND of groups; each group is OR of its items
  excluded: Item[];
  freeText: string;          // natural-language remainder for semantic ranking
  mode: "semantic" | "hybrid" | "keyword";
}

const OP_DETECT = /(^|\s)(AND|OR|NOT)(\s|$)|["+\-]|\*/;

export function parseQuery(raw: string): ParsedQuery {
  const query = raw.trim();
  const hasOperators = OP_DETECT.test(query);

  if (!hasOperators) {
    return {
      hasOperators: false,
      requiredGroups: [],
      excluded: [],
      freeText: query,
      mode: "semantic",
    };
  }

  // Pull out quoted phrases first.
  const phrases: { text: string; neg: boolean }[] = [];
  const rest = query.replace(/(-?)"([^"]+)"/g, (_m, neg, text) => {
    phrases.push({ text, neg: neg === "-" });
    return " ";
  });

  const requiredGroups: Item[][] = [];
  const excluded: Item[] = [];
  const freeWords: string[] = [];

  // Add phrase items.
  for (const p of phrases) {
    const toks = tokenize(p.text);
    if (!toks.length) continue;
    const item: Item = { kind: "phrase", value: p.text, tokens: toks };
    if (p.neg) excluded.push(item);
    else {
      requiredGroups.push([item]);
      freeWords.push(p.text);
    }
  }

  // Walk the remaining whitespace-separated tokens.
  const parts = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];

    if (p === "AND") { i++; continue; }            // AND is the default
    if (p === "NOT") {                              // NOT <term>
      const nxt = parts[++i];
      if (nxt) excluded.push(makeItem(nxt));
      i++;
      continue;
    }
    if (p === "OR") {                               // join previous group
      const nxt = parts[++i];
      if (nxt && requiredGroups.length) {
        requiredGroups[requiredGroups.length - 1].push(makeItem(nxt));
        freeWords.push(stripOps(nxt));
      }
      i++;
      continue;
    }
    if (p.startsWith("-")) {                         // -excluded
      const t = p.slice(1);
      if (t) excluded.push(makeItem(t));
      i++;
      continue;
    }
    // plain or +required term
    const t = p.startsWith("+") ? p.slice(1) : p;
    if (t) {
      requiredGroups.push([makeItem(t)]);
      freeWords.push(stripOps(t));
    }
    i++;
  }

  const freeText = freeWords.join(" ").trim();
  const mode: ParsedQuery["mode"] = requiredGroups.length ? "hybrid" : "keyword";

  return { hasOperators: true, requiredGroups, excluded, freeText, mode };
}

function stripOps(s: string): string {
  return s.replace(/[+\-*"]/g, "");
}

function makeItem(raw: string): Item {
  const s = stripOps(raw).toLowerCase();
  if (raw.includes("*")) return { kind: "wildcard", value: s };
  return { kind: "term", value: s };
}

// ── Evaluate a parsed query against the inverted index ────────────────────────

function ranksForItem(item: Item, index: TextIndex): Set<number> {
  if (item.kind === "phrase") {
    // Loose phrase: cases containing ALL tokens (no adjacency check).
    const toks = item.tokens ?? [];
    if (!toks.length) return new Set();
    let acc: Set<number> | null = null;
    for (const t of toks) {
      const posting = new Set(index[t] ?? []);
      acc = acc ? intersect(acc, posting) : posting;
      if (acc.size === 0) break;
    }
    return acc ?? new Set();
  }
  if (item.kind === "wildcard") {
    const out = new Set<number>();
    for (const key in index) {
      if (key.startsWith(item.value)) for (const r of index[key]) out.add(r);
    }
    return out;
  }
  return new Set(index[item.value] ?? []);
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

/** Ranks satisfying the boolean query (AND of OR-groups, minus exclusions). */
export async function booleanCandidates(parsed: ParsedQuery): Promise<Set<number>> {
  const index = await loadTextIndex();

  let candidates: Set<number> | null = null;
  for (const group of parsed.requiredGroups) {
    // OR within the group.
    const groupSet = new Set<number>();
    for (const item of group) for (const r of ranksForItem(item, index)) groupSet.add(r);
    candidates = candidates ? intersect(candidates, groupSet) : groupSet;
    if (candidates.size === 0) break;
  }

  // No required terms (e.g. only exclusions) → start from everything.
  if (candidates === null) {
    candidates = new Set<number>();
    for (const key in index) for (const r of index[key]) candidates.add(r);
  }

  // Apply exclusions.
  for (const item of parsed.excluded) {
    for (const r of ranksForItem(item, index)) candidates.delete(r);
  }

  return candidates;
}
