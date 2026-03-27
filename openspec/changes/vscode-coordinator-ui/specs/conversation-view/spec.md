## ADDED Requirements

### Requirement: Extension provides a webview panel showing the live agent conversation
The extension SHALL contribute a VS Code webview panel that renders each agent turn from the active session's audit log as a full styled message, including the complete message body from the `content` field, updating in real time as new turns arrive. The panel SHALL be openable via the command palette and the sidebar.

#### Scenario: Panel opened with active session
- **WHEN** the user opens the conversation panel and an active session exists
- **THEN** the webview SHALL render all agent turns recorded so far in chronological order, then continue to append new turns as they arrive

#### Scenario: Panel opened with no active session
- **WHEN** the user opens the conversation panel and no session is active
- **THEN** the webview SHALL display "Waiting for coordinator session…" and populate automatically once a session starts

#### Scenario: New agent turn appended live
- **WHEN** a new `agent_invocation` audit log entry is dispatched to the conversation view
- **THEN** the webview SHALL append the new message bubble within 500ms without a full page reload

### Requirement: Each agent turn is rendered with role, action, and full message content
The conversation webview SHALL render each agent turn as a distinct message bubble containing: the agent role (claude / codex) as a label, the action as a badge (approve / request-changes / block / comment / implement / submit), the artifact ID and round number, and the full `content` field from the audit log entry rendered as markdown.

#### Scenario: Approve action rendered
- **WHEN** an agent turn with action "approve" is rendered
- **THEN** the message bubble SHALL display a green "approve" badge alongside the agent role label, artifact ID, and the agent's full approval reasoning rendered as markdown

#### Scenario: Request-changes action rendered
- **WHEN** an agent turn with action "request-changes" is rendered
- **THEN** the message bubble SHALL display an amber "request-changes" badge and render the full change-request content as a markdown body, so the user can read exactly what feedback was given

#### Scenario: Block action rendered
- **WHEN** an agent turn with action "block" is rendered
- **THEN** the message bubble SHALL display a red "block" badge and include a visual separator indicating the workflow was escalated to a human checkpoint

### Requirement: Conversation view groups turns by consensus round
The conversation webview SHALL visually group agent turns by artifact and round number, with a round header displaying the artifact ID, round number, and outcome derived from audit-log events (in-progress / consensus-reached / needs-revision / block).

#### Scenario: Round header shown at round boundary
- **WHEN** the first agent turn for a new artifact or revision round is rendered
- **THEN** the webview SHALL insert a round header above it showing the artifact ID, round number, and a pending outcome indicator

#### Scenario: Round outcome updated on completion
- **WHEN** both agents have submitted their turns for a round and the consensus evaluator has produced an outcome
- **THEN** the round header SHALL update in place to reflect the final outcome (consensus-reached, needs-revision, or block)

### Requirement: Conversation view auto-scrolls to the latest message
The conversation webview SHALL keep the most recent message visible by scrolling to the bottom automatically when new turns arrive, unless the user has manually scrolled up.

#### Scenario: Auto-scroll while at bottom
- **WHEN** a new message arrives and the user has not scrolled up
- **THEN** the webview SHALL scroll to make the new message visible

#### Scenario: Auto-scroll paused while user scrolls
- **WHEN** the user scrolls upward in the conversation view
- **THEN** the webview SHALL stop auto-scrolling until the user returns to the bottom of the view
