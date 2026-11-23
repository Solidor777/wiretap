# batch: what Foundry does with a batch, and how `settle` reads it

Sent with `foundry.documents.modifyBatch`. Behaviour READ in the 14.364 tree (`server-backend.mjs`, batch handler `#r`;
the 14.369 tree names it `#a`: cite behaviour, not the name): the client drops cancelled entries and no-op updates
(an operation with nothing left is not sent); the server validates all first and writes nothing on a validation error
but still returns dry-run echoes of the passing requests (the client treats them as real: ghost creates, phantom
deletes); it then applies one by one and stops at the first failure, NO rollback. Errors surface only as notifications.

`settle` matches results to operations by document id, the parent of the result (`SettleEntry.parent`, kept because
Foundry deletes `operation.parent` while sending) and, for a create, ids no other sent operation touches (states
applied, unchanged, partial, cancelled, failed, echo);
`confirmAfterFailure` asks the server (`database.get` with `_id` equality per id; `$in` returns nothing, MEASURED),
removes ghost creates and restores phantom deletes; `incomplete` throws `WRITE_NOT_APPLIED` ("N of M operations
applied, X unchanged, Y partly cancelled by a hook, Z cancelled by a hook, W failed, V not written; the batch is not
atomic", <= 256 B). Unchanged or cancelled updates ack `changed: []`; in an embedded update group with several entries,
an entry Foundry dropped (unchanged or hook-cancelled) simply has no paths in the ack and the batch raises no error, an
update is never `partial` (tested in `writeBatchStrict.test.js`). Compendium pack operations cannot be re-checked.
