## ADDED Requirements

### Requirement: README is the primary entry point
The project SHALL provide a `readme.md` at the repository root that enables a new user to go from zero to a running dry-run session without consulting any other document.

#### Scenario: New user follows README
- **WHEN** a user reads `readme.md` and follows it from top to bottom
- **THEN** they SHALL be able to install dependencies, configure `.env` and `mcp-config.json`, and execute `npm start -- start --dry-run` successfully

#### Scenario: README covers all required configuration
- **WHEN** a user inspects `readme.md`
- **THEN** it SHALL document every environment variable in `.env.example`, every field in `mcp-config.json`, and every CLI flag accepted by `npm start`

### Requirement: Architecture documentation explains the MCP coordination bus
The project SHALL provide `docs/architecture.md` that explains why MCP is used as the single coordination bus, how the three tool categories relate to each other, and the end-to-end flow of a consensus round.

#### Scenario: Developer understands the coordination model
- **WHEN** a developer reads `docs/architecture.md`
- **THEN** they SHALL understand: the role of the coordinator MCP server, how Claude connects natively, how Codex is proxied, the independent first-pass review model, and the distinction between consensus-reached and human-approved outcomes

#### Scenario: Architecture doc includes message flow
- **WHEN** a developer reads `docs/architecture.md`
- **THEN** it SHALL contain an ASCII diagram showing the message flow for a single consensus round, from artifact submission through both agent invocations to outcome

### Requirement: MCP tool reference documents all 11 tools
The project SHALL provide `docs/tools.md` documenting every tool registered on the coordinator MCP server.

#### Scenario: Tool reference is complete
- **WHEN** a user reads `docs/tools.md`
- **THEN** every tool SHALL have: a one-line description, its input parameter schema (name, type, required/optional), its return value structure, and at least one example invocation

#### Scenario: Tool reference covers all three categories
- **WHEN** a user reads `docs/tools.md`
- **THEN** it SHALL have clearly separated sections for shared tools, agent trigger tools, and workflow tools

### Requirement: Session format documents state.json and audit.log
The project SHALL provide `docs/session-format.md` that documents the schema of `sessions/<id>/state.json` and the structure of each entry type in `sessions/<id>/audit.log`.

#### Scenario: Operator can parse the audit log
- **WHEN** an operator reads `docs/session-format.md`
- **THEN** they SHALL be able to identify every audit entry type, its fields, and its meaning without reading source code

#### Scenario: Resuming a session is documented
- **WHEN** a user reads `docs/session-format.md`
- **THEN** it SHALL explain how to resume an interrupted session using `--session <id>` and what fields in `state.json` determine which phase the coordinator resumes from

### Requirement: Documentation is kept co-located with the code
All documentation files SHALL live in the repository alongside the source code (`readme.md` at root, reference docs under `docs/`). Documentation SHALL NOT be published to an external service or wiki that could drift from the implementation.

#### Scenario: Docs are in version control
- **WHEN** a contributor checks out the repository
- **THEN** all documentation files SHALL be present and readable without any additional fetch or install steps
