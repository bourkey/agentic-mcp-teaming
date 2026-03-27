## ADDED Requirements

### Requirement: Extension surfaces human checkpoint events as VS Code notification dialogs
The extension SHALL detect `checkpoint_presented` events in the audit log and present unresolved checkpoints to the user as VS Code information message notifications with Proceed and Abort action buttons.

#### Scenario: Checkpoint notification shown
- **WHEN** a `checkpoint_presented` audit log entry indicates the coordinator is waiting at a human checkpoint
- **THEN** the extension SHALL display a VS Code information message containing the checkpoint summary (phase, artifact ID, reason for escalation) and two action buttons: "Proceed" and "Abort"

#### Scenario: Checkpoint already resolved
- **WHEN** the extension is resumed or restarted and replays audit log entries where a `checkpoint_presented` entry is later followed by `checkpoint_resolved` for the same artifact
- **THEN** the extension SHALL NOT show a notification for that checkpoint — only unresolved checkpoints at the tail of the log trigger notifications

### Requirement: Clicking Proceed or Abort sends the decision to the coordinator
The extension SHALL call the coordinator's `resolve_checkpoint` MCP tool via `POST /message` when the user clicks a checkpoint notification button, passing the user's decision and the checkpoint artifact ID.

#### Scenario: User clicks Proceed
- **WHEN** the user clicks "Proceed" in a checkpoint notification
- **THEN** the extension SHALL POST a `resolve_checkpoint` tool call with `decision: "proceed"` to the coordinator's MCP HTTP endpoint and dismiss the notification

#### Scenario: User clicks Abort
- **WHEN** the user clicks "Abort" in a checkpoint notification
- **THEN** the extension SHALL POST a `resolve_checkpoint` tool call with `decision: "abort"` to the coordinator's MCP HTTP endpoint and dismiss the notification

#### Scenario: MCP call fails
- **WHEN** the `resolve_checkpoint` POST fails (coordinator unreachable or returns an error)
- **THEN** the extension SHALL show an error notification with the failure reason and keep the checkpoint notification visible so the user can retry

### Requirement: Checkpoint summary is shown in the sidebar alongside the notification
The extension SHALL update the session panel tree view to highlight the blocked artifact with a "Awaiting decision" label when a checkpoint is active, and clear it once resolved.

#### Scenario: Checkpoint visible in sidebar
- **WHEN** a checkpoint notification is active
- **THEN** the session panel tree node for the affected artifact SHALL display a warning icon and the text "Awaiting human decision"

#### Scenario: Checkpoint resolved in sidebar
- **WHEN** the checkpoint is resolved (proceed or abort)
- **THEN** the warning icon SHALL be replaced with the final outcome icon (checkmark for proceed, cross for abort)
