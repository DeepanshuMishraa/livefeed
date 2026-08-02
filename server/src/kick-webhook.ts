import * as v from "valibot";

const KICK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

const identitySchema = v.nullable(
  v.object({
    badges: v.array(v.object({ type: v.string() })),
  }),
);
const actorSchema = v.object({
  user_id: v.number(),
  username: v.string(),
  is_verified: v.boolean(),
  identity: identitySchema,
});
const chatSchema = v.object({
  message_id: v.string(),
  broadcaster: actorSchema,
  sender: actorSchema,
  content: v.string(),
  created_at: v.string(),
});
const statusSchema = v.object({
  broadcaster: actorSchema,
  is_live: v.boolean(),
});

export type KickRelayEvent =
  | {
      readonly broadcasterUserId: number;
      readonly payload: {
        readonly type: "message";
        readonly event: {
          readonly id: string;
          readonly authorChannelId: string;
          readonly authorName: string;
          readonly role: "owner" | "moderator" | "member" | "viewer";
          readonly verified: boolean;
          readonly message: string;
          readonly publishedAt: string;
          readonly kind: "text";
        };
      };
    }
  | {
      readonly broadcasterUserId: number;
      readonly payload: { readonly type: "started" | "ended" };
    };

export async function verifiedKickEvent(
  request: Request,
): Promise<{ readonly ok: true; readonly event: KickRelayEvent } | { readonly ok: false }> {
  const messageId = request.headers.get("kick-event-message-id");
  const timestamp = request.headers.get("kick-event-message-timestamp");
  const signature = request.headers.get("kick-event-signature");
  const eventType = request.headers.get("kick-event-type");
  if (!messageId || !timestamp || !signature || !eventType) return { ok: false };
  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
    return { ok: false };
  }

  const rawBody = await request.text();
  if (!(await verifySignature(`${messageId}.${timestamp}.${rawBody}`, signature))) {
    return { ok: false };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false };
  }

  if (eventType === "chat.message.sent") {
    const parsed = v.safeParse(chatSchema, body);
    if (!parsed.success) return { ok: false };
    const value = parsed.output;
    const badges = new Set((value.sender.identity?.badges ?? []).map((badge) => badge.type));
    const role =
      value.sender.user_id === value.broadcaster.user_id
        ? "owner"
        : badges.has("moderator")
          ? "moderator"
          : badges.has("subscriber")
            ? "member"
            : "viewer";
    return {
      ok: true,
      event: {
        broadcasterUserId: value.broadcaster.user_id,
        payload: {
          type: "message",
          event: {
            id: value.message_id,
            authorChannelId: String(value.sender.user_id),
            authorName: value.sender.username,
            role,
            verified: value.sender.is_verified,
            message: value.content,
            publishedAt: value.created_at,
            kind: "text",
          },
        },
      },
    };
  }

  if (eventType === "livestream.status.updated") {
    const parsed = v.safeParse(statusSchema, body);
    if (!parsed.success) return { ok: false };
    return {
      ok: true,
      event: {
        broadcasterUserId: parsed.output.broadcaster.user_id,
        payload: { type: parsed.output.is_live ? "started" : "ended" },
      },
    };
  }
  return { ok: false };
}

async function verifySignature(message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemBytes(KICK_PUBLIC_KEY),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64Bytes(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

function pemBytes(pem: string): Uint8Array<ArrayBuffer> {
  return base64Bytes(pem.replace(/-----[^-]+-----/g, "").replaceAll(/\s/g, ""));
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
