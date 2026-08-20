# Anti-slop engineering policy

This is the governing policy for the repository's anti-slop lint integration
(`tools/oxlint/anti-slop` and `oxlint.config.ts`). It is the source of truth for
what the rules protect and what they must never do.

## Engineering hierarchy

Every decision that touches code or a lint rule obeys this priority:

1. Runtime correctness
2. Security / trust boundaries
3. Behavioral compatibility
4. Test fidelity
5. Type-system correctness
6. Simplicity / maintainability
7. Linter compliance

Linter compliance is last. A lint rule must never:

- create fake compile-time certainty;
- replace runtime validation with a generic;
- force reflection-like runtime code to dodge a type assertion;
- reduce test fidelity;
- force meaningless adapters;
- encourage meaningless SAFETY comments;
- make framework/library interoperability harder without a concrete safety
  benefit.

If a rule conflicts with this hierarchy, fix the rule — do not contort
production code to satisfy the linter.

## Trust-boundary policy

`unknown` is CORRECT and preferred at genuine runtime trust boundaries.

The only accepted pattern across a trust boundary:

```text
External / runtime value
        ↓
unknown
        ↓
runtime parser / predicate / schema
        ↓
trusted domain type
```

Examples of genuine trust boundaries where `unknown` (or an explicit
`unknown`-based candidate) is required before validation:

- JWT verification results
- `JSON.parse` output
- external API responses before validation
- socket payloads
- request-derived unvalidated values
- caught exceptions
- deserialized data
- untyped library callbacks

The anti-pattern — never use it:

```text
unknown
        ↓
generic / assertion
        ↓
trusted domain type
```

Do not globally ban `unknown`. Instead, ban unjustified propagation of
`unknown` *through* trusted internal application layers.

### TRUSTED vs UNTRUSTED values

The two categories need different handling:

- **TRUSTED but poorly typed framework/library value.** A narrowly documented
  type assertion may be justified at a genuine framework/library boundary
  (for example an Engine.IO or Socket.IO ID that the declaration marks private,
  or an Express adapter capability). Such assertions are rare, must be direct
  (never `as unknown as`), and must carry a truthful adjacent `SAFETY:` comment
  naming the producer and the exact members relied on.
- **UNTRUSTED runtime value.** Requires runtime validation through a parser or
  type predicate before any typed use. Never accept it via a bare type
  assertion or a compile-time generic.

## What anti-slop rules exist to catch

- accidental broad typing;
- fake assertions;
- unsafe dictionaries;
- unnecessary module mocking;
- unexplained framework casts;
- `unknown` leaking deep into internal domain layers;
- code produced only to satisfy TypeScript superficially.

Anti-slop rules must NOT prohibit:

- genuine boundary parsing;
- type predicates;
- narrow integration adapters;
- properly documented framework assertions;
- tests intentionally constructing malformed runtime values;
- simple direct runtime code.

## Decision test

For every production implementation produced while changing anti-slop rules or
remediating code, ask:

> Would we still write this production implementation if the anti-slop linter
> did not exist?

If the answer is NO, either the implementation or the lint rule needs
reconsideration. A lint rule is a guardrail, never the reason a design exists.
