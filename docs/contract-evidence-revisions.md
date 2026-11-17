# Evidence contract revisions

Before starting verification, requirement evaluation, review or independent acceptance,
read and retain the task's current contract revision alongside its SubjectReference.
MCP write summaries expose `contract_revision`; task query summaries/full task objects
and Completion Packets expose `contractRevision`. Contract revisions are positive
integers and are separate from Git `revision` and the schema's `contract_version`.

Return that captured revision, not a revision fetched after the work finished:

- MCP requirement, verification and review report inputs: `contract_revision`.
- MCP acceptance report: `acceptance_record.contract_revision`.
- MCP task close: top-level `contract_revision` for the batch, or the field on each
  `close_requirements` / `close_verifications` entry.
- Core event API: top-level `contract_revision` or the field on the corresponding
  requirement result, verification claim, review attestation or acceptance record.

Both envelope and per-record values, when supplied, must agree. The revision must
match the task's contract after any mutation in the same event. A mismatch rejects
the event with HTTP 409 `CONTRACT_REVISION_MISMATCH`, without appending evidence.
After a contract change, perform the affected verification/evaluation again against
the new contract. Merely relabeling old evidence with the latest revision is invalid.
Closing without new evidence remains supported and does not require this field.

Legacy callers that omit the field are interpreted as revision 1, never as the current
revision. They continue to work on unchanged initial contracts; after a contract
change they must upgrade and produce new evidence. Invalid revision values return
400. Requirement and verification evidence, review and both acceptance outcomes use
the same rule; review remains advisory rather than a completion gate.

Historical stored events with a durable `contract_revision` retain that binding
during recovery. This fix does not retrospectively establish producer provenance for
events accepted by older versions, which stamped the arrival-time contract revision.
If delayed evidence may have been accepted before the fix, independently re-evaluate
that evidence rather than treating this protocol change as retrospective validation.
