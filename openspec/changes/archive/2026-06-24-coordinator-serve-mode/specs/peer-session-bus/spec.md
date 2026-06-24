## ADDED Requirements

### Requirement: Peer-bus coordinator lifecycle is independent of phase workflow

When the peer bus is enabled, the coordinator's HTTP server and peer-bus persistence SHALL remain available until the coordinator process receives a termination signal. The lifecycle SHALL NOT be tied to any single workflow execution; phase completion (`runProposalPhase`, `runDesignPhase`, `runSpecsPhase`, `runTasksPhase`, `ImplementationPhase` finishing) SHALL NOT cause the HTTP server to stop when the coordinator was started in `serve` mode.

The phase-driven `start` subcommand MAY still shut down the HTTP server when its workflow finishes — that is the defined shape for one-shot phase-driven runs. Operators running the peer bus for long-lived tmux teaming SHALL use the `serve` subcommand, which does not run phases at all.

#### Scenario: Serve keeps the HTTP server alive across days
- **WHEN** `serve` is running with `peerBus.enabled: true` and no signal has been received
- **THEN** the HTTP server SHALL continue accepting connections indefinitely; peer clients SHALL be able to `register_session`, `send_message`, and `read_messages` at any time while the process is alive

#### Scenario: Start mode shutdown behaviour unchanged
- **WHEN** `start` is invoked with `peerBus.enabled: true` and all workflow phases complete
- **THEN** the coordinator SHALL shut down the HTTP server after phase completion per the existing `finally { stopServer() }` pattern; peer sessions connected during the workflow SHALL lose their connections when the process exits. This is the documented, backwards-compatible behaviour for `start`.

#### Scenario: Serve is the recommended mode for tmux teaming
- **WHEN** the documented "Peer session bus" section of the README is followed to set up a tmux-based teaming workflow
- **THEN** the documented command SHALL be `npm start -- serve ...` (not `start`), and the README SHALL state explicitly that `start` is for phase-driven workflows and `serve` is for bus-only operation

### Requirement: Serve-mode session state is bus-only

A `SessionManager` session created or resumed by the `serve` subcommand SHALL have identical on-disk layout to a phase-driven session (`state.json`, `audit.log`, `snapshots/`, plus peer-bus files). The `currentPhase` field in `state.json` SHALL retain its initial value throughout the lifetime of a `serve` session because no phase runs. A `serve` session SHALL NOT be considered "complete" by any workflow criterion.

#### Scenario: Serve session currentPhase never advances
- **WHEN** a `serve` session runs for any duration
- **THEN** `state.json.currentPhase` SHALL equal its initial value at process exit

#### Scenario: Serve and start sessions are separate
- **WHEN** an operator runs `start --workflow proposal ...` while a `serve` coordinator is already running against the same `sessions-dir`
- **THEN** the second coordinator SHALL exit fatally because `coordinator.lock` is held; operators running both simultaneously SHALL use distinct `sessions-dir` values
