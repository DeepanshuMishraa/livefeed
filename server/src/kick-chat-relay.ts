import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import type { Bindings } from "./bindings";
import { secureEqual } from "./domain";

const TOKEN_KEY = "relay-token";
const HISTORY_KEY = "history";
const HISTORY_LIMIT = 2000;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

const relayTokenSchema = v.pipe(v.string(), v.minLength(32), v.maxLength(128));
const chatEventSchema = v.object({
  id: v.string(),
  authorChannelId: v.string(),
  authorName: v.string(),
  role: v.picklist(["owner", "moderator", "member", "viewer"]),
  verified: v.boolean(),
  message: v.string(),
  publishedAt: v.string(),
  kind: v.picklist(["text", "membership", "paid", "gift", "poll", "moderation", "system"]),
});
const relayEventSchema = v.variant("type", [
  v.object({ type: v.literal("message"), event: chatEventSchema }),
  v.object({ type: v.literal("started") }),
  v.object({ type: v.literal("ended") }),
]);
const configureSchema = v.object({ relayToken: relayTokenSchema });
const storedHistorySchema = v.array(chatEventSchema);

type ChatEvent = v.InferOutput<typeof chatEventSchema>;

export class KickChatRelay extends DurableObject<Bindings> {
  override async alarm(): Promise<void> {
    await this.ctx.storage.delete(HISTORY_KEY);
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/configure") return this.configure(request);
    if (request.method === "POST" && path === "/publish") return this.publish(request);
    if (request.method === "POST" && path === "/clear") return this.clear(request);
    if (request.method === "GET" && path === "/history") return this.history(request);
    if (request.method === "GET" && path === "/stream") return this.stream(request);
    return Response.json({ error: "Relay operation was not found." }, { status: 404 });
  }

  private async configure(request: Request): Promise<Response> {
    const body = await parseJson(request, configureSchema);
    if (!body) return Response.json({ error: "Relay configuration was invalid." }, { status: 400 });
    await this.ctx.storage.put(TOKEN_KEY, body.relayToken);
    return Response.json({ ok: true });
  }

  private async publish(request: Request): Promise<Response> {
    const event = await parseJson(request, relayEventSchema);
    if (!event) return Response.json({ error: "Kick event was invalid." }, { status: 400 });

    if (event.type === "message") await this.append(event.event);
    if (event.type === "started" || event.type === "ended") {
      await this.ctx.storage.delete(HISTORY_KEY);
    }
    await this.ctx.storage.setAlarm(Date.now() + HISTORY_RETENTION_MS);

    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "Relay delivery failed");
      }
    }
    return new Response(null, { status: 204 });
  }

  private async clear(request: Request): Promise<Response> {
    if (!(await this.authorized(request))) return unauthorized();
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Signed out");
    await this.ctx.storage.deleteAll();
    return new Response(null, { status: 204 });
  }

  private async history(request: Request): Promise<Response> {
    if (!(await this.authorized(request))) return unauthorized();
    return Response.json({ events: await this.readHistory(), nextPageToken: "" });
  }

  private async stream(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "A WebSocket upgrade is required." }, { status: 426 });
    }
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    const relayToken = protocols[1];
    if (!relayToken || !(await this.tokenMatches(relayToken))) return unauthorized();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "livefeed" },
    });
  }

  private async authorized(request: Request): Promise<boolean> {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.startsWith("Bearer ") && this.tokenMatches(authorization.slice(7));
  }

  private async tokenMatches(candidate: string): Promise<boolean> {
    const stored: unknown = await this.ctx.storage.get(TOKEN_KEY);
    const parsed = v.safeParse(relayTokenSchema, stored);
    return parsed.success && secureEqual(parsed.output, candidate);
  }

  private async append(event: ChatEvent): Promise<void> {
    const history = await this.readHistory();
    const withoutDuplicate = history.filter((existing) => existing.id !== event.id);
    await this.ctx.storage.put(HISTORY_KEY, [...withoutDuplicate, event].slice(-HISTORY_LIMIT));
  }

  private async readHistory(): Promise<readonly ChatEvent[]> {
    const stored: unknown = await this.ctx.storage.get(HISTORY_KEY);
    const parsed = v.safeParse(storedHistorySchema, stored);
    return parsed.success ? parsed.output : [];
  }
}

async function parseJson<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  request: Request,
  schema: TSchema,
): Promise<v.InferOutput<TSchema> | null> {
  try {
    const body: unknown = await request.json();
    const parsed = v.safeParse(schema, body);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return Response.json({ error: "Kick relay authorization failed." }, { status: 401 });
}
