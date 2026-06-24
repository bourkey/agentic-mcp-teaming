## ADDED Requirements

### Requirement: Extension contributes a sidebar tree view for session and phase status
The extension SHALL register a VS Code activity bar icon and sidebar tree view that displays the active session's workflow phase sequence, current phase, and per-artifact consensus status, updating live as audit log events arrive.

#### Scenario: Sidebar shows phase sequence
- **WHEN** the sidebar panel is open and an active session exists
- **THEN** the tree SHALL display all six workflow phases (proposal, design, spec, task, implementation, review) as top-level nodes, with the current phase highlighted and completed phases marked with a checkmark icon

#### Scenario: Artifact status shown under phase node
- **WHEN** a phase node is expanded
- **THEN** the tree SHALL show child nodes for each artifact reviewed in that phase, with its consensus outcome (consensus-reached, human-approved, aborted, in-progress) and revision round count

#### Scenario: No active session
- **WHEN** the sidebar is open but no session is active
- **THEN** the tree SHALL display a single node with the text "No active session — run 'Coordinator: Start' to begin"

### Requirement: Extension registers command palette commands for session lifecycle
The extension SHALL contribute the following commands to the VS Code command palette: "Coordinator: Start", "Coordinator: Resume Session", "Coordinator: Stop", and "Coordinator: Switch Session".

#### Scenario: Start command launches coordinator
- **WHEN** the user runs "Coordinator: Start" from the command palette
- **THEN** the extension SHALL launch the coordinator command (`npm start -- start --workflow proposal`) in a VS Code integrated terminal, using the workspace root as the working directory

#### Scenario: Resume command prompts for session ID
- **WHEN** the user runs "Coordinator: Resume Session"
- **THEN** the extension SHALL show a quick-pick list of all session IDs found in the sessions directory and, upon selection, spawn the coordinator with `--session <id>`

#### Scenario: Stop command closes the managed coordinator terminal
- **WHEN** the user runs "Coordinator: Stop" and a coordinator process was started by the extension
- **THEN** the extension SHALL dispose the VS Code terminal instance it created for that session and update all views to a stopped state

### Requirement: Status bar item reflects coordinator connection state
The extension SHALL maintain a status bar item in the bottom bar of VS Code that reflects the current coordinator connection state at all times.

#### Scenario: Connected with active session
- **WHEN** the extension is connected to the coordinator and an active session is running
- **THEN** the status bar item SHALL display "Coordinator: <phase> (round <n>)" and be clickable to focus the sidebar panel

#### Scenario: Disconnected or no session
- **WHEN** the coordinator is not running or no active session exists
- **THEN** the status bar item SHALL display "Coordinator: idle" with a grey indicator
