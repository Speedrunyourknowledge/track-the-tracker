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
