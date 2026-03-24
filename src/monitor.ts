import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { feedGroupStyleMessage } from "./group-style.js";
import {
  DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  readJsonBodyWithLimit,
  type OpenClawConfig,
  type RuntimeEnv,
} from "./openclaw-compat.js";

import { resolveGeweAccount } from "./accounts.js";
import { parseGeweJsonText } from "./api.js";
import { GeweDownloadQueue } from "./download-queue.js";
import { createGeweInboundDebouncer } from "./inbound-batch.js";
import { handleGeweInboundBatch } from "./inbound.js";
import { createGeweMediaServer, DEFAULT_MEDIA_HOST, DEFAULT_MEDIA_PATH, DEFAULT_MEDIA_PORT } from "./media-server.js";
import { maybeHandleGeweMediaRequest } from "./media-server.js";
import { getGeweRuntime } from "./runtime.js";
import type {
  CoreConfig,
  GeweCallbackPayload,
  GeweInboundMessage,
  GeweWebhookServerOptions,
  ResolvedGeweAccount,
} from "./types.js";
import { extractAtUserList } from "./xml.js";
const DEFAULT_WEBHOOK_PORT = 4399;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const HEALTH_PATH = "/healthz";
const DEDUPE_TTL_MS = 12 * 60 * 60 * 1000;

const SEEN_MESSAGES = new Map<string, number>();

function cleanupSeen() {
  const now = Date.now();
  for (const [key, ts] of SEEN_MESSAGES.entries()) {
    if (now - ts > DEDUPE_TTL_MS) {
      SEEN_MESSAGES.delete(key);
    }
  }
}

function isDuplicate(key: string): boolean {
  cleanupSeen();
  if (SEEN_MESSAGES.has(key)) return true;
  SEEN_MESSAGES.set(key, Date.now());
  return false;
}

export function buildGeweInboundDedupeKey(params: {
  accountId: string;
  message: Pick<GeweInboundMessage, "appId" | "newMessageId">;
}): string {
  return `${params.accountId}:${params.message.appId}:${params.message.newMessageId}`;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

function resolveWebhookToken(req: IncomingMessage): string | undefined {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const candidates = [
    headers["x-gewe-callback-token"],
    headers["x-webhook-token"],
    headers["x-gewe-token"],
  ];
  for (const value of candidates) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const first = value[0]?.trim();
      if (first) return first;
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function validateWebhookSecret(
  req: IncomingMessage,
  path: string,
  secret?: string,
): { ok: boolean; reason?: string } {
  if (!secret) return { ok: true };
  const headerToken = resolveWebhookToken(req);
  if (headerToken && headerToken === secret) return { ok: true };
  try {
    const url = new URL(req.url ?? "", `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");
    if (token && token === secret) return { ok: true };
  } catch {
    // ignore URL parse errors
  }
  return {
    ok: false,
    reason: `Missing or invalid webhook token for ${path}`,
  };
}

function splitGroupContent(raw: string): { senderId?: string; body: string } {
  const marker = ":\n";
  const index = raw.indexOf(marker);
  if (index > 0) {
    const sender = raw.slice(0, index).trim();
    const body = raw.slice(index + marker.length);
    if (sender) return { senderId: sender, body };
  }
  return { body: raw };
}

function resolveSenderName(pushContent?: string): string | undefined {
  const value = pushContent?.trim();
  if (!value) return undefined;
  const index = value.indexOf(" : ");
  if (index > 0) {
    return value.slice(0, index).trim() || undefined;
  }
  const altIndex = value.indexOf(": ");
  if (altIndex > 0) {
    return value.slice(0, altIndex).trim() || undefined;
  }
  return undefined;
}

function parseWebhookPayload(body: string): GeweCallbackPayload | null {
  try {
    const data = parseGeweJsonText<GeweCallbackPayload>(body);
    return data as GeweCallbackPayload;
  } catch {
    return null;
  }
}

export let wxId = "";

function payloadToInboundMessage(payload: GeweCallbackPayload, config?: CoreConfig): GeweInboundMessage | null {
  console.log("收到回调消息" + JSON.stringify(payload));



  const appId = payload.appid?.trim() ?? "";
  const botWxid = payload.wxId?.trim() ?? "";
  wxId = botWxid;
  const data = payload.data;
  if (!data || !appId || !botWxid) return null;

  const fromId = data.FromUserName?.string?.trim() ?? "";
  const toId = data.ToUserName?.string?.trim() ?? "";
  const msgType = typeof data.MsgType === "number" ? data.MsgType : -1;



  const content = data.Content?.string ?? "";
  const msgId = data.MsgId ?? data.NewMsgId ?? 0;
  const newMsgId = data.NewMsgId ?? data.MsgId ?? 0;
  const createTime = data.CreateTime ?? 0;
  const timestamp = createTime ? createTime * 1000 : Date.now();
  if (!fromId || !toId || msgType < 0) return null;

  const isGroupChat = fromId.endsWith("@chatroom") || toId.endsWith("@chatroom");
  const groupParsed = isGroupChat ? splitGroupContent(content) : { body: content };
  const senderId = (isGroupChat ? groupParsed.senderId : fromId) ?? fromId;
  const text = groupParsed.body?.trim() ?? "";
  const atWxids = extractAtUserList(data.MsgSource);
  const atAll = atWxids.includes("notify@all");
  const message = {
    messageId: String(msgId),
    newMessageId: String(newMsgId),
    appId,
    botWxid,
    fromId,
    toId,
    senderId,
    senderName: resolveSenderName(data.PushContent),
    text,
    atWxids: atWxids.length ? atWxids : undefined,
    atAll,
    msgType,
    xml: text,
    timestamp,
    isGroupChat,
  };
  saveMessageToFile(message, config);
  return message;
}
// 回调消息处理,保存到本地文件夹,根据日期创建文件夹,文件夹名称为年月日,文件名称fromId  文件格式为json 格式为 timestamp senderName text

function saveMessageToFile(message: GeweInboundMessage, config?: CoreConfig) {
  
  if (message.msgType !== 1) return;

  try {
    const synodeaiConfig = config?.channels?.synodeai;
    if (!synodeaiConfig?.isSaveLog) return;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const defaultDir = process.platform === 'win32' ? "C:\\openclaw" : process.platform === 'darwin' ? "~/Library/Application Support/openclaw" : "~/.openclaw";
    const baseDir = synodeaiConfig.logAddress || defaultDir;
    const resolvedBaseDir = baseDir.replace(/^~/, homedir());
    const chatDir = join(resolvedBaseDir, "memory", "chat");

    const isGroup = message.isGroupChat;
    const entityId = isGroup ? message.fromId : message.senderId;
    const entityDir = join(chatDir, isGroup ? "groups" : "private", entityId);
    const messageFile = join(entityDir, `${dateStr}.jsonl`);

    mkdirSync(entityDir, { recursive: true });

    const content = {
      newMessageId: message.newMessageId,
      timestamp: message.timestamp,
      type: message.msgType,
      senderId: message.senderId,
      senderName: message.senderName,
      content: message.text,
      isMe: message.senderId === message.botWxid
    };

    writeFileSync(messageFile, JSON.stringify(content) + '\n', { flag: 'a' });

    const profileFile = join(entityDir, "profile.json");
    if (!existsSync(profileFile)) {
      const profile = {
        id: entityId,
        name: message.senderName,
        type: isGroup ? "group" : "private",
        createdAt: Date.now(),
        lastMessageAt: message.timestamp
      };
      writeFileSync(profileFile, JSON.stringify(profile, null, 2));
    } else {
      const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
      profile.lastMessageAt = message.timestamp;
      if (message.senderName) {
        profile.name = message.senderName;
      }
      writeFileSync(profileFile, JSON.stringify(profile, null, 2));
    }

    const indexFile = join(chatDir, "index.json");
    if (!existsSync(indexFile)) {
      const index = {
        entities: [
          {
            id: entityId,
            name: message.senderName,
            type: isGroup ? "group" : "private",
            lastMessageAt: message.timestamp
          }
        ],
        updatedAt: Date.now()
      };
      writeFileSync(indexFile, JSON.stringify(index, null, 2));
    } else {
      const index = JSON.parse(readFileSync(indexFile, 'utf8'));
      const existingEntity = index.entities.find((e: any) => e.id === entityId);
      if (existingEntity) {
        existingEntity.lastMessageAt = message.timestamp;
        if (message.senderName) {
          existingEntity.name = message.senderName;
        }
      } else {
        index.entities.push({
          id: entityId,
          name: message.senderName,
          type: isGroup ? "group" : "private",
          lastMessageAt: message.timestamp
        });
      }
      index.updatedAt = Date.now();
      writeFileSync(indexFile, JSON.stringify(index, null, 2));
    }
    // 群风格学习：异步更新统计，不阻塞消息处理
    if (isGroup) {
      try {
        feedGroupStyleMessage({
          groupId: entityId,
          content: message.text,
          timestamp: message.timestamp,
          isMe: message.senderId === message.botWxid,
          baseDir: resolvedBaseDir,
        });
      } catch (styleErr) {
        console.error("[group-style] 更新失败:", styleErr);
      }
    }
  } catch (error) {
    console.error("保存消息到文件失败:", error);
  }
}



export function createGeweWebhookServer(opts: GeweWebhookServerOptions & { config?: CoreConfig }): {
  server: Server;
  start: () => Promise<void>;
  stop: () => void;
} {
  const { port, host, path, mediaPath, secret, onRawPayload, onMessage, onError, abortSignal, config } = opts;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (
      mediaPath &&
      (await maybeHandleGeweMediaRequest({
        req,
        res,
        path: mediaPath,
      }))
    ) {
      return;
    }

    if (req.url?.split("?")[0] !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const auth = validateWebhookSecret(req, path, secret);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: auth.reason || "Unauthorized" }));
      return;
    }

    try {
      const bodyResult = await readJsonBodyWithLimit(req, {
        maxBytes: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
        emptyObjectOnEmpty: false,
      });
      if (!bodyResult.ok) {
        res.writeHead(
          bodyResult.code === "PAYLOAD_TOO_LARGE"
            ? 413
            : bodyResult.code === "REQUEST_BODY_TIMEOUT"
              ? 408
              : 400,
          { "Content-Type": "application/json" },
        );
        res.end(JSON.stringify({ error: bodyResult.error || "Invalid JSON payload" }));
        return;
      }
      onRawPayload?.(bodyResult.raw);
      const payload = parseWebhookPayload(bodyResult.raw);

      if (!payload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      const message = payloadToInboundMessage(payload, config);
      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook payload" }));
        return;
      }

      res.writeHead(200);
      res.end();

      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        reject(err);
      };
      server.once("error", onError);
      try {
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      } catch (err) {
        server.off("error", onError);
        reject(err);
      }
    });
  };

  const stop = () => {
    server.close();
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stop, { once: true });
  }

  return { server, start, stop };
}

export type GeweMonitorOptions = {
  accountId?: string;
  account?: ResolvedGeweAccount;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorGeweProvider(
  opts: GeweMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getGeweRuntime();
  const cfg = opts.config ?? (core.config.loadConfig() as CoreConfig);
  const account = opts.account ?? resolveGeweAccount({ cfg, accountId: opts.accountId });
  const fallbackLogger = core.logging.getChildLogger();
  const formatRuntimeArgs = (args: unknown[]) =>
    args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args: unknown[]) => fallbackLogger.info(formatRuntimeArgs(args)),
    error: (...args: unknown[]) => fallbackLogger.error(formatRuntimeArgs(args)),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  if (!account.token) {
    throw new Error(`SynodeAI token not configured for account "${account.accountId}" (token missing)`);
  }

  const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const rawPath = account.config.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const secret = account.config.webhookSecret?.trim() || undefined;
  const shouldStartMedia =
    Boolean(account.config.mediaPublicUrl) ||
    Boolean(account.config.mediaPort || account.config.mediaHost || account.config.mediaPath);
  const mediaPath = account.config.mediaPath ?? DEFAULT_MEDIA_PATH;

  const downloadQueue = new GeweDownloadQueue({
    minDelayMs: account.config.downloadMinDelayMs,
    maxDelayMs: account.config.downloadMaxDelayMs,
  });
  const debouncer = createGeweInboundDebouncer({
    cfg: cfg as OpenClawConfig,
    accountId: account.accountId,
    isControlCommand: (text) => core.channel.text.hasControlCommand(text, cfg as OpenClawConfig),
    onFlush: async (messages) => {
      await handleGeweInboundBatch({
        messages,
        account,
        config: cfg,
        runtime,
        downloadQueue,
        statusSink: opts.statusSink,
      });
    },
    onError: (err) => runtime.error?.(`SynodeAI inbound debounce flush failed: ${String(err)}`),
  });

  const webhookServer = createGeweWebhookServer({
    port,
    host,
    path,
    mediaPath: shouldStartMedia ? mediaPath : undefined,
    secret,
    config: cfg,
    onRawPayload: (raw) => runtime.log?.(`[${account.accountId}] GeWe webhook raw: ${raw}`),
    onMessage: async (message) => {
      const isSelf = message.fromId === message.botWxid || message.senderId === message.botWxid;
      if (isSelf) return;

      const dedupeKey = buildGeweInboundDedupeKey({
        accountId: account.accountId,
        message,
      });
      if (isDuplicate(dedupeKey)) return;
      opts.statusSink?.({ lastInboundAt: Date.now() });

      await debouncer.enqueue(message);
    },
    onError: (err) => runtime.error?.(`SynodeAI webhook error: ${String(err)}`),
    abortSignal: opts.abortSignal,
  });

  await webhookServer.start();
  const webhookPublicUrl =
    account.config.webhookPublicUrl?.trim() ||
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  runtime.log?.(`[${account.accountId}] SynodeAI webhook server listening on ${webhookPublicUrl}`);

  let mediaStop: (() => void) | undefined;

  if (shouldStartMedia) {
    const mediaServer = createGeweMediaServer({
      host: account.config.mediaHost ?? DEFAULT_MEDIA_HOST,
      port: account.config.mediaPort ?? DEFAULT_MEDIA_PORT,
      path: mediaPath,
      abortSignal: opts.abortSignal,
    });
    await mediaServer.start();
    mediaStop = mediaServer.stop;
    runtime.log?.(
      `[${account.accountId}] SynodeAI media server listening on ${account.config.mediaHost ?? DEFAULT_MEDIA_HOST}:${account.config.mediaPort ?? DEFAULT_MEDIA_PORT}${account.config.mediaPath ?? DEFAULT_MEDIA_PATH}`,
    );
  }

  let resolveRunning: (() => void) | undefined;
  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    if (!opts.abortSignal) return;
    if (opts.abortSignal.aborted) {
      resolve();
      return;
    }
    opts.abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  const stop = () => {
    void debouncer.flushAll();
    webhookServer.stop();
    if (mediaStop) mediaStop();
    resolveRunning?.();
  };

  await runningPromise;

  return { stop };
}
