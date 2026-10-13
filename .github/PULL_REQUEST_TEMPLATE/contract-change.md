<!--
Contract-change PR (PLAN §3, frozen by T-02). Open it with
?template=contract-change.md. One contract-change PR per phase batches every
addition that phase needs (I-08); a worker never edits the contract files in
a feature PR.

Contract files: src/ports/*.ts, src/domain/types.ts,
src/domain/{rules,watches,settings}/schema.ts, src/domain/settings/defaults.ts,
src/domain/{snipe,calendar,audit}/types.ts, src/domain/storage/schema.ts,
src/messaging/protocol.ts, test/contract/types/**.
-->

## Contract change: Phase <N>

**Requested by:** <cards, e.g. T-111, T-112, T-113>
**Plan reference:** <§3.x and the PLAN §16 amendment row, if any>

### Changes

| §3 section | Type / message / key | Change (add, widen, narrow, rename, remove) | Why |
|---|---|---|---|
|  |  |  |  |

### Compatibility

- [ ] Stored data: every changed record still parses, or this PR adds a migration in `src/domain/storage/migrations.ts` with a test that loads the old shape (§2.3). A new field is optional or has a zod `.default()`.
- [ ] Messages: a new type is in `MSG_SENDER` with the right sender group, and the router allow-lists (§2.4) were reviewed.
- [ ] No existing consumer breaks: list each card or file that uses a changed type and what it must do.

### Checklist

- [ ] `planning/PLAN.md` §3 (and `.superpowers/sdd/PLAN/context/contracts.md`) updated in this PR, word for word with the code.
- [ ] Each type changed together with its `<Name>Schema`; types still derived with `z.infer` where §3 shows a plain shape.
- [ ] One valid and one invalid example for every new or changed type in `test/contract/types/examples/` (and `examples/Msg/` for messages); `EXPECTED_SCHEMAS` and the `spec-shapes` mirror updated.
- [ ] §3 functions stay type-only; implementations stay with their cards.
- [ ] Outputs pasted below.

```
pnpm test:contract -- test/contract/types
pnpm typecheck
pnpm lint
```
