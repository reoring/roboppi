# Build a Word-Counter CLI (Bun + TypeScript)

## Goal

Build a small Bun + TypeScript CLI tool that counts text statistics from a file and outputs JSON.

## What to build

### 1. Core library: `src/counter.ts`

Export a function:

```typescript
interface CountStats {
  lines: number;
  words: number;
  chars: number;
  top_words: Array<{ word: string; count: number }>;
}

function countStats(text: string): CountStats;
```

- `lines`: number of lines (split by `\n`; empty string → 0 lines)
- `words`: number of whitespace-separated tokens
- `chars`: total character count (including whitespace)
- `top_words`: top 5 most frequent words, sorted descending by count, then alphabetically. Words are lowercased and stripped of leading/trailing punctuation (`.,!?;:'"()`).

### 2. CLI entry point: `src/cli.ts`

Usage: `bun run src/cli.ts <filepath>`

- Read the file at `<filepath>`.
- Call `countStats()` on the file content.
- Print the result as JSON to stdout.
- On error (missing file, no argument), print `{"error": "<message>"}` to stderr and exit with code 1.

### 3. Tests: `test/counter.test.ts`

Unit tests using `bun:test`:

- Basic counting: known input → expected lines, words, chars.
- Top words: verify correct ranking and count.
- Empty string: lines=0, words=0, chars=0, top_words=[].
- Punctuation stripping: "hello, world! hello." → top_words includes `{word:"hello", count:2}`.
- Unicode: handles multi-byte characters correctly for char count.
- Single word repeated: e.g. "foo foo foo" → top_words=[{word:"foo", count:3}].

### 4. Project setup: `package.json`

```json
{
  "name": "word-counter",
  "version": "1.0.0",
  "scripts": {
    "start": "bun run src/cli.ts",
    "test": "bun test"
  }
}
```

## Acceptance Criteria

- [ ] `package.json` exists with `test` script.
- [ ] `src/counter.ts` exports `countStats`.
- [ ] `src/cli.ts` reads a file and prints JSON to stdout.
- [ ] `test/counter.test.ts` covers the cases listed above.
- [ ] `bun test` passes.
- [ ] `bun run src/cli.ts <file>` outputs valid JSON with `{ lines, words, chars, top_words }`.
- [ ] Error case: `bun run src/cli.ts nonexistent.txt` prints error JSON to stderr and exits 1.
- [ ] Top words are correctly sorted (descending count, then alphabetical).
- [ ] Punctuation is stripped from word boundaries.
