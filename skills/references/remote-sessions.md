# Remote socket sessions

A controller and an execution host share one `SessionManager` per machine. The execution host listens on an owner-only Unix socket. The controller reaches another machine by forwarding that socket over an existing SSH config alias. There is no LAN listener and no new network secret.

When the config file is missing or `"enabled"` is false, every existing local CLI and tool path is unchanged.

## Install

Both hosts are Ubuntu. The controller needs an OpenSSH client. The peer needs an OpenSSH server, an existing alias in the operator's SSH config, and Unix stream-local forwarding. The broker process is long-running:

```text
clawo remote-broker --config ~/.claw-orchestrator/remote-hosts.json
```

Do not set `CLAWO_REMOTE_EXECUTION_BROKER` on a controller. `clawo remote-broker` sets it so that process cannot open another forward. Optional flags: `--ttl-minutes` (default 120) and `--max-sessions` (otherwise `CLAWO_MAX_CONCURRENT_SESSIONS`, default 5, `0` for unlimited). Active native turns and accepted remote operations are excluded from idle TTL.

The broker does not start the embedded HTTP server. MCP and plugin teardown close only that process's sockets and SSH forwards. Broker shutdown stops only the engines that broker started.

## Config

Default path: `~/.claw-orchestrator/remote-hosts.json`. Override with `CLAWO_REMOTE_CONFIG`. No other environment variable is read for host identity.

```json
{
  "enabled": true,
  "localHost": "yoga",
  "parentMachineId": "00000000-0000-4000-8000-000000000001",
  "parentToolId": "cursor",
  "socketPath": "/run/user/1000/clawo/broker.sock",
  "hosts": {
    "yoga": { "socketPath": "/run/user/1000/clawo/broker.sock" },
    "studio": {
      "sshAlias": "studio",
      "remoteSocketPath": "/run/user/1000/clawo/broker.sock"
    }
  }
}
```

- `localHost` is the configured display name of the machine reading the file. It is not the kernel hostname.
- `parentMachineId` is a UUID. Optional `parentMachineIdFile` is used only when the whole trimmed file is a UUID. A JSON or token file is ignored and its contents are not logged.
- `parentToolId` is `codex`, `claude_code`, `cursor`, or `opencode`.
- Socket paths are absolute and shorter than 104 bytes. The directory is mode `0700` and the socket is mode `0600`.
- A peer needs `sshAlias` and `remoteSocketPath`. An unknown host is an error. The call is not run locally instead.
- With the feature enabled, a call that omits `host` still uses this machine's broker, so there is one SessionManager.

The SSH child is only:

```text
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes -L <local.sock>:<remote.sock> <alias>
```

`ClearAllForwardings` is not passed. OpenSSH applies it to command-line forwards as well, which would remove this `-L`. Host key checking stays at SSH's default. Model-supplied SSH options are not accepted. The broker's session registry and PID file live in `~/.claw-orchestrator/remote-broker/`, not the shared `~/.openclaw` registry used by other SessionManager processes.

## Names and operations

A remote session handle is `host::localName`. The native resume id stays in `resumeSessionId` / `claudeSessionId` and is never wrapped in that handle.

`operationId` is chosen by the client and must be 1–128 characters from letters, numbers, and `. _ : -`. The same id and the same payload rejoin an operation. A changed payload is rejected. Acceptance is stored before the turn starts, and the final result is stored before it is returned. If the socket drops after acceptance, repeat the same id; that does not start a second native turn.

`--timeout` / `timeout` is the native execution timeout. `--wait-timeout` / `waitTimeout` is only how long the controller waits. A short wait returns `{ ok: true, status: "running", operationId }`. `thread_mailbox_wait` is different: its `waitTimeout` is the broker mailbox deadline (default 30 seconds, maximum 3,600,000) and stays in the operation payload.

If the broker process restarts while an operation is still `accepted` or `running`, that record becomes `uncertain` and is not replayed.

## CLI

```text
clawo session-start worker --host studio --cwd /home/intpa/proj --engine codex-app --model gpt-6.1-sol --effort xhigh --parent-session-id <native-parent-id> --parent-tool-id cursor --operation-id op-start-1
clawo session-send studio::worker "MEMENTO-DELEGATE-FROM: <native-parent-id>
do the work" --timeout 3600000 --wait-timeout 30000 --operation-id op-send-1
clawo session-list --host studio
clawo session-stop studio::worker
clawo thread-register manual-codex --host studio --native-session-id <uuid> --parent-tool-id codex
clawo thread-mailbox-send manual-codex "hello" --host studio --from yoga::parent --message-id msg-1
clawo thread-mailbox-wait manual-codex --host studio --wait-timeout 60000
clawo thread-mailbox-ack msg-1 --host studio
```

## Tools

These tools gain optional `host`, `operationId`, and `waitTimeout`: `session_start`, `session_send`, `session_stop`, `session_list`, `sessions_overview`, `coding_session_status`, `session_send_to`, `session_inbox`, `session_deliver_inbox`.

`session_start` also accepts `parentMachineId`, `parentSessionId`, `parentToolId`, and `originHost`. The broker sets `executionHost` from its own `localHost`. It sets `remoteSessionHandle` when origin and execution differ. A first line `MEMENTO-DELEGATE-FROM: <id>` fills a missing parent session id and emits the usual lifecycle event. `MEMENTO-HANDOFF-FROM` and `MEMENTO-TANGENT-FROM` do not.

New tools, all broker-only:

| Tool | Required fields | Behavior |
| --- | --- | --- |
| `thread_register` | `name`, `nativeSessionId` | Records a manual thread. Does not spawn or resume it. Refuses a name that is already a live managed session. |
| `thread_mailbox_send` | `name`, `from`, `message` | Queues mail for a registered thread. Optional `messageId`. Does not start a native turn. |
| `thread_mailbox_read` | `name` | Reads that thread. `unreadOnly` defaults to true. Concurrent reads see the same unread mail until ack. |
| `thread_mailbox_ack` | `messageId` or `messageIds` | Marks mail read. Ack of an already-read id succeeds again. |
| `thread_mailbox_wait` | `name` | Resolves when unread mail is queued, or when `waitTimeout` elapses. |

Managed `session_send_to` goes through SessionManager's serialized turn path. A TCP write is not model delivery. Status stays `queued` until the serialized send finishes, then `read`. A native wait timeout marks that message `uncertain` and does not retry it. Broadcast `*` reaches managed sessions on that broker only and skips the sender.

## Not routed

`session_grep`, compact, handoff, council, fanout, workflow, and ultraapp have no `host` parameter. They keep running on the local process and cannot silently execute on a peer. Remote `session_send` returns the final turn result and does not stream mid-turn chunks. Frames are capped at 4 MB; a larger result is stored as completed and truncated so the turn is not replayed.
