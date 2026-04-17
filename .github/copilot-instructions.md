# Copilot Instructions

## Brace Style (Stroustrup)

This project enforces `brace-style: stroustrup` via ESLint. Follow these rules for ALL generated code:

### `else` / `catch` / `finally` go on their own line after `}`

```ts
// ✅ Correct
if (condition) {
  doSomething();
}
else {
  doOther();
}

try {
  riskyOp();
}
catch (e) {
  handle(e);
}

// ❌ Wrong — do not put else on the same line as }
if (condition) {
  doSomething();
} else {
  doOther();
}
```

### No single-line `if` statements — always use braces, always expand to multiple lines

```ts
// ✅ Correct
if (!value) {
  return "";
}

// ❌ Wrong — do not use braceless if statements
if (!value) return "";

// ❌ Wrong — do not use single-line blocks
if (!value) { return ""; }
```

### Same rule applies to `for` loops

```ts
// ✅ Correct
for (const item of list) {
  process(item);
}

// ❌ Wrong — do not use braceless for loops
for (const item of list) process(item);

// ❌ Wrong — do not use single-line blocks
for (const item of list) { process(item); }
```

## Comment Style

Add a comment above every significant function and every non-obvious logical flow.

### File-level comments

Every custom file (non-boilerplate) should begin with a JSDoc comment explaining its purpose. Keep it to 2–3 lines.

```ts
// ✅ Correct
/**
 * Utility functions for validating and sanitizing user input.
 * Ensures values meet expected formats before being passed to the rest of the app.
 */
```

### Format rules

- Use JSDoc (`/** */`) for exported functions and at the top of every custom file. Use `//` for everything else
- The last line of a comment never ends with a period. A period is only used to separate sentences within a multi-sentence comment
- Do not use all-caps emphasis words (MUST, IMPORTANT, etc.)
- Keep comments concise — one to three lines is almost always enough
- Do not narrate what the code already makes obvious — if the logic is self-evident, skip the comment or just name the intent in one line
