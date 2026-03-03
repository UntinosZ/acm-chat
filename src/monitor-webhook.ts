import type { IncomingMessage, ServerResponse } from "node:http";
import * as pluginSdkMod from "openclaw/plugin-sdk";
import type { WebhookInFlightLimiter } from "openclaw/plugin-sdk";

const _sdkW = pluginSdkMod as unknown as Record<string, unknown>;

// resolveWebhookTargets fallback: match request path against the targets map
type ResolvedTargets<T> = { path: string; targets: T[] } | null;
const _resolveWebhookTargets = _sdkW["resolveWebhookTargets"] as
  | (<T>(req: IncomingMessage, map: Map<string, T[]>) => ResolvedTargets<T>)
  | undefined;
function resolveWebhookTargets<T>(req: IncomingMessage, map: Map<string, T[]>): ResolvedTargets<T> {
  if (_resolveWebhookTargets) return _resolveWebhookTargets(req, map);
  const path = (req.url ?? "").split("?")[0] ?? "";
  const found = map.get(path);
  if (!found?.length) return null;
  return { path, targets: found };
}

// beginWebhookRequestPipelineOrReject fallback: validate method, return release noop
type PipelineResult = { ok: boolean; release: () => void };
const _beginWebhookRequestPipelineOrReject = _sdkW["beginWebhookRequestPipelineOrReject"] as
  | ((p: { req: IncomingMessage; res: ServerResponse; allowMethods?: string[]; requireJsonContentType?: boolean; inFlightLimiter?: unknown; inFlightKey?: string }) => PipelineResult)
  | undefined;
function beginWebhookRequestPipelineOrReject(params: {
  req: IncomingMessage; res: ServerResponse; allowMethods?: string[];
  requireJsonContentType?: boolean; inFlightLimiter?: unknown; inFlightKey?: string;
}): PipelineResult {
  if (_beginWebhookRequestPipelineOrReject) return _beginWebhookRequestPipelineOrReject(params);
  const method = (params.req.method ?? "").toUpperCase();
  if (params.allowMethods && !params.allowMethods.includes(method)) {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", params.allowMethods.join(", "));
    params.res.end("Method Not Allowed");
    return { ok: false, release: () => {} };
  }
  return { ok: true, release: () => {} };
}

// readJsonWebhookBodyOrReject fallback: read and parse request body as JSON
type BodyResult = { ok: boolean; value?: unknown };
const _readJsonWebhookBodyOrReject = _sdkW["readJsonWebhookBodyOrReject"] as
  | ((p: { req: IncomingMessage; res: ServerResponse; profile?: string; emptyObjectOnEmpty?: boolean; invalidJsonMessage?: string }) => Promise<BodyResult>)
  | undefined;
async function readJsonWebhookBodyOrReject(params: {
  req: IncomingMessage; res: ServerResponse; profile?: string;
  emptyObjectOnEmpty?: boolean; invalidJsonMessage?: string;
}): Promise<BodyResult> {
  if (_readJsonWebhookBodyOrReject) return _readJsonWebhookBodyOrReject(params);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    params.req.on("data", (chunk: unknown) => chunks.push(Buffer.from(chunk as Buffer)));
    params.req.on("end", resolve);
    params.req.on("error", reject);
  });
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw && params.emptyObjectOnEmpty) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    params.res.statusCode = 400;
    params.res.end(params.invalidJsonMessage ?? "invalid JSON");
    return { ok: false };
  }
}

// resolveWebhookTargetWithAuthOrReject fallback: iterate targets and call isMatch
const _resolveWebhookTargetWithAuthOrReject = _sdkW["resolveWebhookTargetWithAuthOrReject"] as
  | (<T>(p: { targets: T[]; res: ServerResponse; isMatch: (t: T) => Promise<boolean> }) => Promise<T | null>)
  | undefined;
async function resolveWebhookTargetWithAuthOrReject<T>(params: {
  targets: T[]; res: ServerResponse; isMatch: (target: T) => Promise<boolean>;
}): Promise<T | null> {
  if (_resolveWebhookTargetWithAuthOrReject) return _resolveWebhookTargetWithAuthOrReject(params);
  for (const target of params.targets) {
    if (await params.isMatch(target)) return target;
  }
  params.res.statusCode = 401;
  params.res.end("unauthorized");
  return null;
}
import { verifyGoogleChatRequest } from "./auth.js";
import type { WebhookTarget } from "./monitor-types.js";
import type {
  GoogleChatEvent,
  GoogleChatMessage,
  GoogleChatSpace,
  GoogleChatUser,
} from "./types.js";

function extractBearerToken(header: unknown): string {
  const authHeader = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
  return authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice("bearer ".length).trim()
    : "";
}

type ParsedGoogleChatInboundPayload =
  | { ok: true; event: GoogleChatEvent; addOnBearerToken: string }
  | { ok: false };

function parseGoogleChatInboundPayload(
  raw: unknown,
  res: ServerResponse,
): ParsedGoogleChatInboundPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  let eventPayload = raw;
  let addOnBearerToken = "";

  // Transform Google Workspace Add-on format to standard Chat API format.
  const rawObj = raw as {
    commonEventObject?: { hostApp?: string };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      user?: GoogleChatUser;
      eventTime?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat?.messagePayload) {
    const chat = rawObj.chat;
    const messagePayload = chat.messagePayload;
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload?.space,
      message: messagePayload?.message,
      user: chat.user,
      eventTime: chat.eventTime,
    };
    addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? (eventPayload as { eventType?: string }).eventType;
  if (typeof eventType !== "string") {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (eventType === "MESSAGE") {
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      res.statusCode = 400;
      res.end("invalid payload");
      return { ok: false };
    }
  }

  return { ok: true, event, addOnBearerToken };
}

export function createGoogleChatWebhookRequestHandler(params: {
  webhookTargets: Map<string, WebhookTarget[]>;
  webhookInFlightLimiter: WebhookInFlightLimiter | null;
  processEvent: (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const resolved = resolveWebhookTargets(req, params.webhookTargets);
    if (!resolved) {
      return false;
    }
    const { path, targets } = resolved;

    const requestLifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      inFlightLimiter: params.webhookInFlightLimiter ?? undefined,
      inFlightKey: `${path}:${req.socket?.remoteAddress ?? "unknown"}`,
    });
    if (!requestLifecycle.ok) {
      return true;
    }

    try {
      const headerBearer = extractBearerToken(req.headers.authorization);
      let selectedTarget: WebhookTarget | null = null;
      let parsedEvent: GoogleChatEvent | null = null;

      if (headerBearer) {
        selectedTarget = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (target) => {
            const verification = await verifyGoogleChatRequest({
              bearer: headerBearer,
              audienceType: target.audienceType,
              audience: target.audience,
            });
            return verification.ok;
          },
        });
        if (!selectedTarget) {
          return true;
        }

        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          profile: "post-auth",
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid payload",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = parseGoogleChatInboundPayload(body.value, res);
        if (!parsed.ok) {
          return true;
        }
        parsedEvent = parsed.event;
      } else {
        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          profile: "pre-auth",
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid payload",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = parseGoogleChatInboundPayload(body.value, res);
        if (!parsed.ok) {
          return true;
        }
        parsedEvent = parsed.event;

        if (!parsed.addOnBearerToken) {
          res.statusCode = 401;
          res.end("unauthorized");
          return true;
        }

        selectedTarget = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (target) => {
            const verification = await verifyGoogleChatRequest({
              bearer: parsed.addOnBearerToken,
              audienceType: target.audienceType,
              audience: target.audience,
            });
            return verification.ok;
          },
        });
        if (!selectedTarget) {
          return true;
        }
      }

      if (!selectedTarget || !parsedEvent) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }

      const dispatchTarget = selectedTarget;
      dispatchTarget.statusSink?.({ lastInboundAt: Date.now() });
      params.processEvent(parsedEvent, dispatchTarget).catch((err) => {
        dispatchTarget.runtime.error?.(
          `[${dispatchTarget.account.accountId}] Google Chat webhook failed: ${String(err)}`,
        );
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
      return true;
    } finally {
      requestLifecycle.release();
    }
  };
}
