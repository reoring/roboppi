# Build a Small Linear Algebra CLI (Bun + TypeScript)

## Goal
Demonstrate that the agent PR loop can produce real, testable source code (not just workflow notes).

## What to build
Create a Bun + TypeScript project that provides:

1) A small library under `src/` with:
- Rational arithmetic (fractions) sufficient for exact computations on small integer matrices/vectors.
- Matrix/vector utilities.
- Algorithms:
  - Solve a square linear system `A x = b` via Gaussian elimination using rationals.
  - Eigenvalues/eigenvectors and diagonalization check for 2x2 matrices.
  - Orthogonal projection of a vector onto the span of given vectors (use rationals where possible).

2) A CLI entrypoint `src/cli.ts` that supports commands:
- `solve --A <json> --b <json>`
- `eigen2x2 --A <json>`
- `project --basis <json> --b <json>`

Input format:
- `--A` is a JSON array of arrays (example: `[[1,2],[3,4]]`).
- `--b` is a JSON array (example: `[5,6]`).
- `--basis` is a JSON array of vectors (example: `[[1,0,0],[0,1,0]]`).

Output:
- Print results as JSON to stdout.
- For rationals, output as reduced strings like `"11/2"` or `"-1"`.

3) Tests
- Add unit tests under `test/` (bun test) covering all three algorithms and a couple edge cases.
- For `solve`, include at least one edge case where a pivot column is all zeros but the system is still inconsistent (e.g. `A=[[0,1],[0,1]]`, `b=[1,2]` should return `ok:false` with `error:"inconsistent"`).
- For `eigen2x2`, when the matrix is a scalar matrix (e.g. `[[5,0],[0,5]]`), return two independent eigenvectors (a basis), not two identical vectors.
- `bun test` must pass.

4) Docs
- Update `README.md` with a "How to run" section including example CLI invocations and expected JSON shape.

## Acceptance Criteria
- [ ] `package.json` exists and `bun test` passes.
- [ ] `src/` contains the library code and `src/cli.ts` implements the CLI.
- [ ] `bun run src/cli.ts solve ...` works for at least one example.
- [ ] Outputs use reduced rational strings (no floating point for exact cases).
- [ ] README documents usage.
- [ ] `solve` correctly distinguishes `inconsistent` vs `singular`, including a case where the first pivot column is all zeros.
- [ ] `eigen2x2` returns a valid eigenvector basis for scalar matrices when `diagonalizable:true`.
