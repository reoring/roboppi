# Build a Multi-Module Utility Library (Bun + TypeScript)

## Goal

Build a Bun + TypeScript utility library with two independent modules: math utilities and string utilities. Each module should be implemented by a separate developer and tested independently.

## Modules

### 1. Math module: `src/math.ts`

Export the following functions:

```typescript
/** Add two numbers */
function add(a: number, b: number): number;

/** Subtract b from a */
function subtract(a: number, b: number): number;

/** Multiply two numbers */
function multiply(a: number, b: number): number;

/** Divide a by b. Throws Error if b is 0. */
function divide(a: number, b: number): number;
```

Edge cases:
- `divide(x, 0)` must throw an `Error` with message "Division by zero"
- All functions must handle negative numbers correctly
- All functions must handle floating point (e.g., `add(0.1, 0.2)` should be close to 0.3)

### 2. String module: `src/string-utils.ts`

Export the following functions:

```typescript
/** Capitalize the first letter of a string */
function capitalize(s: string): string;

/** Reverse a string (Unicode-safe) */
function reverse(s: string): string;

/** Truncate a string to maxLen chars, appending "..." if truncated */
function truncate(s: string, maxLen: number): string;

/** Convert a string to a URL-friendly slug */
function slugify(s: string): string;
```

Specification:
- `capitalize("")` returns `""`
- `capitalize("hello")` returns `"Hello"`
- `reverse("abc")` returns `"cba"`
- `reverse("")` returns `""`
- `truncate("hello world", 5)` returns `"he..."`
- `truncate("hi", 5)` returns `"hi"` (no truncation needed)
- `truncate("hello", 5)` returns `"hello"` (exact fit, no truncation)
- `slugify("Hello World!")` returns `"hello-world"`
- `slugify("  foo  BAR  baz  ")` returns `"foo-bar-baz"`
- `slugify("café")` returns `"cafe"` (strip diacritics)

### 3. Tests

#### `test/math.test.ts`

Using `bun:test`:
- Basic arithmetic: `add(1,2)===3`, `subtract(5,3)===2`, `multiply(3,4)===12`, `divide(10,2)===5`
- Negative numbers: `add(-1,-2)===-3`, `multiply(-2,3)===-6`
- Division by zero: `divide(1,0)` throws "Division by zero"
- Floating point: `add(0.1, 0.2)` is approximately 0.3

#### `test/string-utils.test.ts`

Using `bun:test`:
- capitalize: empty string, single word, already capitalized
- reverse: empty string, palindrome, unicode
- truncate: shorter than max, exact length, longer than max
- slugify: spaces, punctuation, mixed case, diacritics

### 4. Project setup: `package.json`

```json
{
  "name": "multi-module-utils",
  "version": "1.0.0",
  "scripts": {
    "test": "bun test"
  }
}
```

## Acceptance Criteria

- [ ] `package.json` exists with `test` script
- [ ] `src/math.ts` exports all 4 functions
- [ ] `src/string-utils.ts` exports all 4 functions
- [ ] `test/math.test.ts` covers all specified cases
- [ ] `test/string-utils.test.ts` covers all specified cases
- [ ] `bun test` passes with all tests green
- [ ] Division by zero throws correctly
- [ ] String functions handle edge cases (empty string, unicode)
