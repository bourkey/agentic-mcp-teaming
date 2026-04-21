import * as crypto from "crypto";
import { z } from "zod";
import {
  MessageStore,
  computeBodyByteLength,
  nowUtcIso,
  PEER_BUS_MAX_BODY_BYTES,
  type PeerMessage,
} from "../../core/message-store.js";
import {
  SessionRegistry,
  RegistryError,
  PEER_BUS_MAX_UNREAD,
} from "../../core/session-registry.js";
import { SESSION_NAME_REGEX, UUID_V4_REGEX } from "../../core/peer-bus-constants.js";
import { fireTmuxNotifier } from "../../core/notifier-tmux.js";
import type { Logger } from "../../core/logger.js";
import type { PeerBusConfig } from "../../config.js";

const PEER_KIND = z.enum(["workflow-event", "chat", "request", "response"]);

export const RegisterSessionParams = z.object({
  name: z.string(),
  priorSessionToken: z.string().optional(),
});

export const SendMessageParams = z.object({
  sessionToken: z.string(),
  to: z.string(),
  kind: PEER_KIND,
  body: z.unknown(),
  replyTo: z.string().regex(UUID_V4_REGEX, "replyTo must be a UUIDv4").optional(),
});

export const ReadMessagesParams = z.object({
  sessionToken: z.string(),
});

export interface PeerBusContext {
  registry: SessionRegistry;
  store: MessageStore;
  notifierConfig: PeerBusConfig["notifier"];
  logger: Logger;
  audit: PeerBusAuditor;
  /** Test hook: run notifier synchronously so tests can assert call count. */
  notifierFireAndAwait?: boolean;
}

export interface PeerBusAuditor {
  log(entry: Record<string, unknown>): void;
}

type MCPResult = {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type MCPErrorResult = MCPResult & { isError: true };
type MCPSuccessResult = MCPResult;

function successResult(payload: unknown): MCPSuccessResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(code: string, message: string): MCPErrorResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Strip XML 1.0 illegal control chars (everything in U+0000-U+0008, U+000B, U+000C, U+000E-U+001F)
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function wrapEnvelope(msg: PeerMessage): string {
  const bodyText = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
  const cleanBody = bodyText.replace(XML_ILLEGAL_CTRL, "");
  const body = xmlEscape(cleanBody);
  const from = xmlEscape(msg.from.replace(XML_ILLEGAL_CTRL, ""));
  const kind = xmlEscape(msg.kind.replace(XML_ILLEGAL_CTRL, ""));
  const messageId = xmlEscape(msg.messageId.replace(XML_ILLEGAL_CTRL, ""));
  return `<peer-message from="${from}" kind="${kind}" messageId="${messageId}">${body}</peer-message>`;
}

function hashBody(body: unknown): string {
  const serialised = typeof body === "string" ? body : JSON.stringify(body);
  return crypto.createHash("sha256").update(serialised).digest("hex").slice(0, 16);
}

function mapRegisterZodError(path: ReadonlyArray<string | number>): string {
  const root = path[0];
  if (root === "priorSessionToken") return "invalid_prior_session_token_required";
  return "invalid_session_name";
}

function mapSendZodError(path: ReadonlyArray<string | number>): string {
  const root = path[0];
  if (root === "sessionToken") return "invalid_session_token";
  if (root === "to") return "invalid_recipient_name";
  if (root === "body" || root === "kind" || root === "replyTo") return "invalid_workflow_event_body";
  return "response_internal_error";
}

export async function registerSessionTool(
  ctx: PeerBusContext,
  rawParams: unknown
): Promise<MCPSuccessResult | MCPErrorResult> {
  const parsed = RegisterSessionParams.safeParse(rawParams);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResult(
      mapRegisterZodError(issue?.path ?? []),
      issue?.message ?? "invalid params"
    );
  }
  const { name, priorSessionToken } = parsed.data;

  ctx.audit.log({
    tool: "register_session",
    params: {
      name,
      priorSessionToken: priorSessionToken === undefined ? undefined : "<redacted>",
    },
  });

  if (!SESSION_NAME_REGEX.test(name)) {
    return errorResult("invalid_session_name", "name must match ^[a-z0-9][a-z0-9-]{0,62}$");
  }

  return ctx.registry.withLock(name, async () => {
    const snapshot = ctx.registry.snapshotEntry(name);
    try {
      const { entry, rawToken } = ctx.registry.register(name, priorSessionToken);
      try {
        await ctx.registry.persist();
      } catch (persistErr) {
        // Roll back in-memory register so disk and memory stay consistent
        ctx.registry.restoreEntry(name, snapshot);
        ctx.logger.error("register_session: persist failed, rolled back", {
          name,
          error: (persistErr as Error).message,
        });
        return errorResult("response_internal_error", "failed to persist registry after register");
      }
      return successResult({
        name: entry.name,
        sessionToken: rawToken,
        registeredAt: entry.registeredAt,
      });
    } catch (err) {
      if (err instanceof RegistryError) {
        return errorResult(err.code, err.message);
      }
      ctx.logger.error("register_session: unexpected error", {
        error: (err as Error).message,
      });
      return errorResult("response_internal_error", "internal error during registration");
    }
  });
}

export async function sendMessageTool(
  ctx: PeerBusContext,
  rawParams: unknown
): Promise<MCPSuccessResult | MCPErrorResult> {
  const parsed = SendMessageParams.safeParse(rawParams);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResult(mapSendZodError(issue?.path ?? []), issue?.message ?? "invalid params");
  }
  const { sessionToken, to, kind, body, replyTo } = parsed.data;

  const fromEntry = ctx.registry.authenticate(sessionToken);
  if (fromEntry === null) {
    ctx.audit.log({
      tool: "send_message",
      params: { sessionToken: "<redacted>", to, kind, replyTo, result: "invalid_session_token" },
    });
    return errorResult("invalid_session_token", "sessionToken did not authenticate");
  }

  // Authenticated: touch immediately so every authenticated call updates lastSeenAt
  ctx.registry.touch(fromEntry.name);

  if (!SESSION_NAME_REGEX.test(to)) {
    ctx.audit.log({
      tool: "send_message",
      params: { sessionToken: "<redacted>", to, kind, replyTo, result: "invalid_recipient_name" },
    });
    return errorResult("invalid_recipient_name", "recipient name must match session-name regex");
  }

  if (kind === "workflow-event") {
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return errorResult(
        "invalid_workflow_event_body",
        "workflow-event body must be a JSON object"
      );
    }
    const ev = (body as Record<string, unknown>)["event"];
    if (typeof ev !== "string" || ev.length === 0) {
      return errorResult(
        "invalid_workflow_event_body",
        "workflow-event body must include a non-empty string event field"
      );
    }
  }

  const bodyBytes = computeBodyByteLength(body);
  if (bodyBytes > PEER_BUS_MAX_BODY_BYTES) {
    ctx.audit.log({
      tool: "send_message",
      params: {
        sessionToken: "<redacted>",
        to,
        kind,
        replyTo,
        bodyLength: bodyBytes,
        result: "payload_too_large",
      },
    });
    return errorResult("payload_too_large", `body exceeds PEER_BUS_MAX_BODY_BYTES (${PEER_BUS_MAX_BODY_BYTES})`);
  }

  if (!ctx.registry.has(to)) {
    ctx.audit.log({
      tool: "send_message",
      params: { sessionToken: "<redacted>", to, kind, replyTo, result: "recipient_not_registered" },
    });
    return errorResult("recipient_not_registered", `no session registered with name '${to}'`);
  }

  const messageId = crypto.randomUUID();
  const envelope: PeerMessage = {
    messageId,
    from: fromEntry.name,
    to,
    kind,
    body,
    ...(replyTo !== undefined ? { replyTo } : {}),
    timestamp: nowUtcIso(),
  };

  // Check mailbox capacity BEFORE append, snapshot recipient unread for rollback, and wrap
  // the whole critical section so any throw becomes a structured MCP error.
  const result = await ctx.registry.withLocks(fromEntry.name, to, async () => {
    if (!ctx.registry.canAddUnread(to)) {
      return { error: "mailbox_full" as const };
    }
    const recipientSnapshot = ctx.registry.snapshotUnread(to);
    try {
      await ctx.store.append(envelope);
    } catch (err) {
      ctx.logger.error("send_message: store.append failed", { error: (err as Error).message });
      return { error: "response_internal_error" as const, message: "failed to append message to log" };
    }
    // canAddUnread was true under this mutex, so addUnread SHALL succeed
    ctx.registry.addUnread(to, messageId);
    ctx.registry.touch(fromEntry.name);
    ctx.registry.touch(to);
    try {
      await ctx.registry.persist();
    } catch (err) {
      // Roll back in-memory unread so the disk orphan is at least consistent with memory
      if (recipientSnapshot !== null) ctx.registry.restoreUnread(to, recipientSnapshot);
      ctx.logger.error("send_message: registry.persist failed, rolled back", {
        error: (err as Error).message,
      });
      return { error: "response_internal_error" as const, message: "failed to persist registry after send" };
    }
    return { ok: true as const };
  });

  if ("error" in result) {
    const code = result.error;
    const message =
      code === "mailbox_full"
        ? `recipient '${to}' has reached PEER_BUS_MAX_UNREAD (${PEER_BUS_MAX_UNREAD})`
        : ("message" in result ? result.message : "internal error");
    ctx.audit.log({
      tool: "send_message",
      params: {
        sessionToken: "<redacted>",
        to,
        kind,
        replyTo,
        messageId,
        bodyLength: bodyBytes,
        bodyHash: hashBody(body),
        result: code,
      },
    });
    return errorResult(code, message);
  }

  ctx.audit.log({
    tool: "send_message",
    params: {
      sessionToken: "<redacted>",
      to,
      kind,
      replyTo,
      messageId,
      bodyLength: bodyBytes,
      bodyHash: hashBody(body),
      result: "ok",
    },
  });

  // Fire-and-forget notifier after mutex release
  if (ctx.notifierConfig.tmuxEnabled) {
    const notifierPromise = fireTmuxNotifier({
      recipientName: to,
      from: fromEntry.name,
      kind,
      format: ctx.notifierConfig.displayMessageFormat,
      tabStyle: ctx.notifierConfig.unreadTabStyle,
      logger: ctx.logger,
    });
    if (ctx.notifierFireAndAwait === true) {
      await notifierPromise;
    } else {
      notifierPromise.catch((err) => {
        ctx.logger.error("peer-bus: notifier promise rejected", { error: (err as Error).message });
      });
    }
  }

  return successResult({ messageId });
}

export async function readMessagesTool(
  ctx: PeerBusContext,
  rawParams: unknown
): Promise<MCPSuccessResult | MCPErrorResult> {
  const parsed = ReadMessagesParams.safeParse(rawParams);
  if (!parsed.success) {
    return errorResult("invalid_session_token", "sessionToken is required");
  }
  const { sessionToken } = parsed.data;

  const caller = ctx.registry.authenticate(sessionToken);
  if (caller === null) {
    ctx.audit.log({
      tool: "read_messages",
      params: { sessionToken: "<redacted>", result: "invalid_session_token" },
    });
    return errorResult("invalid_session_token", "sessionToken did not authenticate");
  }

  // Authenticated: touch immediately so error paths below still update lastSeenAt
  ctx.registry.touch(caller.name);

  return ctx.registry.withLock(caller.name, async () => {
    // loadAll() MUST run inside the mutex so that a send_message that completes
    // between auth and lock acquisition is visible to drainUnread.
    let messageLookup: Map<string, PeerMessage>;
    try {
      messageLookup = await ctx.store.loadAll();
    } catch (err) {
      ctx.logger.error("read_messages: loadAll failed", { error: (err as Error).message });
      return errorResult("response_internal_error", "failed to load message store");
    }

    const snapshot = ctx.registry.snapshotUnread(caller.name);
    let drained: { messages: Array<{ messageId: string; wrapped: string }>; hasMore: boolean };
    try {
      drained = ctx.registry.drainUnread(caller.name, messageLookup, wrapEnvelope);
    } catch (err) {
      ctx.logger.error("read_messages: drainUnread threw", { error: (err as Error).message });
      if (snapshot !== null) ctx.registry.restoreUnread(caller.name, snapshot);
      return errorResult("response_internal_error", "failed to drain mailbox");
    }

    ctx.registry.touch(caller.name);
    try {
      await ctx.registry.persist();
    } catch (err) {
      // Roll back in-memory drain so disk and memory stay consistent
      ctx.logger.error("read_messages: persist failed, rolling back drain", {
        error: (err as Error).message,
      });
      if (snapshot !== null) ctx.registry.restoreUnread(caller.name, snapshot);
      return errorResult("response_internal_error", "failed to persist registry after drain");
    }

    ctx.audit.log({
      tool: "read_messages",
      params: {
        sessionToken: "<redacted>",
        count: drained.messages.length,
        firstId: drained.messages[0]?.messageId,
        lastId: drained.messages[drained.messages.length - 1]?.messageId,
        hasMore: drained.hasMore,
      },
    });

    return successResult({ messages: drained.messages, hasMore: drained.hasMore });
  });
}
