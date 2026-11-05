import { createHash } from "node:crypto";

export const idempotentEventFields = [
  "session_switch_id",
  "event_id", "type", "task_id", "context_task_id", "requirement_id", "session_id",
  "agent", "provider", "model", "workspace", "project_id", "title", "goal", "status", "priority",
  "plan", "current_step", "next_action", "blocker", "acceptance_criteria", "changed_files",
  "tests", "evidence", "assumptions", "risks", "tradeoffs", "open_questions", "retrospective",
  "expected_at", "archived_at", "superseded_by", "review_reason", "reviewed_at", "tool_name",
  "due_at", "estimated_effort_ms", "estimate_reason",
  "tool_use_id",
  "contract_version", "scope", "non_goals", "workflow_profile", "review_policy", "execution_environment",
  "verification_plan", "revision", "requirement_result", "verification_claim", "review_attestation", "review_cycle",
  "phase", "transition", "activity_source", "activity_id", "review_cycle_id",
  "diagnostic_observation", "execution_observation",
  "close_requirements", "close_verifications",
  "context_completion_id", "authorization_id", "reason", "actor", "subject_ref", "acceptance_record", "workspace_policy",
];

export function eventFingerprint(event) {
  const fields = event.type === "phase.reported" ? [...idempotentEventFields, "occurred_at"] : idempotentEventFields;
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.map(field => [field, event[field]])))).digest("hex");
}
