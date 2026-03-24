import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extensionForMime,
  extractOriginalFilename,
  type OpenClawConfig,
  type ReplyPayload,
} from "./openclaw-compat.js";
import { runBinaryCommand, type BinaryCommandResult } from "./binary-command.js";
import { CHANNEL_ID } from "./constants.js";
import { getGeweRuntime } from "./runtime.js";
import { resolveS3Config, uploadToS3 } from "./s3.js";
import { buildRustSilkEncodeArgs, ensureRustSilkBinary } from "./silk.js";
import {
  forwardFileGewe,
  forwardImageGewe,
  forwardLinkGewe,
  forwardMiniAppGewe,
  forwardVideoGewe,
  sendAppMsgGewe,
  sendEmojiGewe,
  sendFileGewe,
  sendImageGewe,
  sendLinkGewe,
  sendMiniAppGewe,
  sendNameCardGewe,
  sendTextGewe,
  sendVideoGewe,
  sendVoiceGewe,
  revokeMessageGewe,
} from "./send.js";
import { recallGeweQuoteReplyContext } from "./quote-context-cache.js";
import type { GeweSendResult, ResolvedGeweAccount } from "./types.js";

type GeweChannelData = {
  ats?: string;
  appMsg?: {
    appmsg: string;
  };
  quoteReply?: {
    svrid?: string | number;
    title?: string;
    atWxid?: string;
    partialText?: {
      text?: string;
      start?: string;
      end?: string;
      startIndex?: string | number;
      endIndex?: string | number;
      quoteMd5?: string;
    };
  };
  emoji?: {
    emojiMd5: string;
    emojiSize: number;
  };
  nameCard?: {
    nickName: string;
    nameCardWxid: string;
  };
  miniApp?: {
    miniAppId: string;
    displayName: string;
    pagePath: string;
    coverImgUrl: string;
    title: string;
    userName: string;
  };
  revoke?: {
    msgId: string | number;
    newMsgId: string | number;
    createTime: string | number;
  };
  forward?: {
    kind: "image" | "video" | "file" | "link" | "miniApp";
    xml: string;
    coverImgUrl?: string;
  };
  link?: {
    title: string;
    desc: string;
    linkUrl: string;
    thumbUrl?: string;
  };
  video?: {
    thumbUrl: string;
    videoDuration: number;
  };
  voiceDuration?: number;
  voiceDurationMs?: number;
  fileName?: string;
  forceFile?: boolean;
};

type ResolvedMedia = {
  publicUrl: string;
  base64?: string;
  contentType?: string;
  fileName?: string;
  localPath?: string;
  sourceKind: "remote" | "local";
  sourceUrl: string;
  provider: "direct" | "s3" | "proxy";
};

const LINK_THUMB_MAX_BYTES = 50 * 1024;
const LINK_THUMB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const LINK_THUMB_MAX_SIDE = 320;
const LINK_THUMB_QUALITY_STEPS = [80, 70, 60, 50, 40];
const DEFAULT_VOICE_SAMPLE_RATE = 24000;
const DEFAULT_VOICE_FFMPEG = "ffmpeg";
const DEFAULT_VOICE_SILK = "silk-encoder";
const DEFAULT_VOICE_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_FFMPEG = "ffmpeg";
const DEFAULT_VIDEO_FFPROBE = "ffprobe";
const DEFAULT_VIDEO_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_THUMB_SECONDS = 0.5;
const PCM_BYTES_PER_SAMPLE = 2;
const DEFAULT_LINK_THUMB_PATH = fileURLToPath(
  new URL("../assets/gewe-rs_logo.jpeg", import.meta.url),
);

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isFileUrl(value: string): boolean {
  return /^file:\/\//i.test(value);
}

function normalizeFileUrl(value: string): string {
  if (!isFileUrl(value)) return value;
  try {
    const url = new URL(value);
    return url.pathname ? decodeURIComponent(url.pathname) : value;
  } catch {
    return value;
  }
}

function looksLikeTtsVoiceMediaUrl(value: string): boolean {
  if (!value || looksLikeHttpUrl(value)) return false;
  const localPath = normalizeFileUrl(value);
  const base = path.basename(localPath).toLowerCase();
  const parent = path.basename(path.dirname(localPath)).toLowerCase();
  if (!/^voice-\d+/.test(base)) return false;
  return parent.startsWith("tts-");
}

function buildPublicUrl(baseUrl: string, id: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/${encodeURIComponent(id)}`;
}

function hasProxyBase(account: ResolvedGeweAccount): boolean {
  return Boolean(account.config.mediaPublicUrl?.trim());
}

function hasS3(account: ResolvedGeweAccount): boolean {
  return account.config.s3Enabled === true;
}

function resolveFallbackProviders(account: ResolvedGeweAccount): Array<"s3" | "proxy"> {
  const providers: Array<"s3" | "proxy"> = [];
  if (hasS3(account)) providers.push("s3");
  if (hasProxyBase(account)) providers.push("proxy");
  return providers;
}

function resolveMediaMaxBytes(account: ResolvedGeweAccount): number {
  const maxMb = account.config.mediaMaxMb;
  if (typeof maxMb === "number" && maxMb > 0) return Math.floor(maxMb * 1024 * 1024);
  return 20 * 1024 * 1024;
}

function resolveGeweData(payload: ReplyPayload): GeweChannelData | undefined {
  const data = payload.channelData as
    | { "synodeai"?: GeweChannelData; gewe?: GeweChannelData }
    | undefined;
  return data?.[CHANNEL_ID] ?? data?.gewe;
}

function isSilkAudio(opts: { contentType?: string; fileName?: string }): boolean {
  if (opts.contentType?.toLowerCase().includes("silk")) return true;
  return opts.fileName?.toLowerCase().endsWith(".silk") ?? false;
}

function resolveVoiceDurationMs(geweData?: GeweChannelData): number | undefined {
  const ms =
    typeof geweData?.voiceDurationMs === "number"
      ? geweData.voiceDurationMs
      : typeof geweData?.voiceDuration === "number"
        ? geweData.voiceDuration
        : undefined;
  if (!ms || ms <= 0) return undefined;
  return Math.floor(ms);
}

function resolveVoiceSampleRate(account: ResolvedGeweAccount): number {
  const rate = account.config.voiceSampleRate;
  if (typeof rate === "number" && rate > 0) return Math.floor(rate);
  return DEFAULT_VOICE_SAMPLE_RATE;
}

function resolveVideoFfmpegPath(account: ResolvedGeweAccount): string {
  return (
    account.config.videoFfmpegPath?.trim() ||
    account.config.voiceFfmpegPath?.trim() ||
    DEFAULT_VIDEO_FFMPEG
  );
}

function resolveVideoFfprobePath(account: ResolvedGeweAccount, ffmpegPath: string): string {
  const configured = account.config.videoFfprobePath?.trim();
  if (configured) return configured;
  if (ffmpegPath.endsWith("ffmpeg")) {
    return `${ffmpegPath.slice(0, -"ffmpeg".length)}ffprobe`;
  }
  return DEFAULT_VIDEO_FFPROBE;
}

async function probeVideoDurationSeconds(params: {
  account: ResolvedGeweAccount;
  sourcePath: string;
}): Promise<number | null> {
  const core = getGeweRuntime();
  const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "video" });
  const ffmpegPath = resolveVideoFfmpegPath(params.account);
  const ffprobePath = resolveVideoFfprobePath(params.account, ffmpegPath);
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    params.sourcePath,
  ];
  const result = await core.system.runCommandWithTimeout([ffprobePath, ...args], {
    timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    logger.warn?.(
      `gewe video probe failed: ${result.stderr.trim() || `exit code ${result.code ?? "?"}`}`,
    );
    return null;
  }
  const raw = result.stdout.trim();
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    logger.warn?.(`gewe video probe returned invalid duration: "${raw}"`);
    return null;
  }
  return Math.max(1, Math.round(seconds));
}

async function generateVideoThumbBuffer(params: {
  account: ResolvedGeweAccount;
  sourcePath: string;
}): Promise<Buffer | null> {
  const core = getGeweRuntime();
  const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "video" });
  const ffmpegPath = resolveVideoFfmpegPath(params.account);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gewe-video-"));
  const thumbPath = path.join(tmpDir, "thumb.png");

  try {
    const args = [
      "-y",
      "-ss",
      String(DEFAULT_VIDEO_THUMB_SECONDS),
      "-i",
      params.sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${LINK_THUMB_MAX_SIDE}:-1:force_original_aspect_ratio=decrease`,
      thumbPath,
    ];
    const result = await core.system.runCommandWithTimeout([ffmpegPath, ...args], {
      timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      logger.warn?.(
        `gewe video thumb failed: ${result.stderr.trim() || `exit code ${result.code ?? "?"}`}`,
      );
      return null;
    }
    const buffer = await fs.readFile(thumbPath);
    if (!buffer.length) {
      logger.warn?.("gewe video thumb generated empty output");
      return null;
    }
    return buffer;
  } catch (err) {
    logger.warn?.(`gewe video thumb failed: ${String(err)}`);
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

function resolveSilkArgs(params: {
  template: string[];
  input: string;
  output: string;
  sampleRate: number;
}): string[] {
  const { template, input, output, sampleRate } = params;
  const mapped = template.map((entry) =>
    entry
      .replace(/\{input\}/g, input)
      .replace(/\{output\}/g, output)
      .replace(/\{sampleRate\}/g, String(sampleRate)),
  );
  const hasInput = template.some((entry) => entry.includes("{input}"));
  const hasOutput = template.some((entry) => entry.includes("{output}"));
  const next = [...mapped];
  if (!hasInput) next.unshift(input);
  if (!hasOutput) next.push(output);
  return next;
}

function trimPcmBuffer(params: {
  buffer: Buffer;
  sampleRate: number;
}): { buffer: Buffer; durationMs: number } {
  let pcmBuffer = params.buffer;
  const frameSamples = params.sampleRate % 50 === 0 ? params.sampleRate / 50 : 0; // 20ms frames
  const frameBytes = frameSamples > 0 ? frameSamples * PCM_BYTES_PER_SAMPLE : 0;
  if (frameBytes > 0 && pcmBuffer.length % frameBytes !== 0) {
    const trimmedSize = pcmBuffer.length - (pcmBuffer.length % frameBytes);
    if (trimmedSize <= 0) {
      throw new Error("ffmpeg produced empty PCM after frame trim");
    }
    pcmBuffer = Buffer.from(pcmBuffer.subarray(0, trimmedSize));
  }
  if (!pcmBuffer.length) {
    throw new Error("ffmpeg produced empty PCM");
  }
  return {
    buffer: pcmBuffer,
    durationMs: Math.max(
      1,
      Math.round((pcmBuffer.length / (params.sampleRate * PCM_BYTES_PER_SAMPLE)) * 1000),
    ),
  };
}

function formatBinaryCommandFailure(params: {
  label: string;
  result: BinaryCommandResult;
}): string {
  if (params.result.timedOut) {
    return `${params.label} timed out after ${DEFAULT_VOICE_TIMEOUT_MS}ms`;
  }
  const detail = params.result.stderr.trim();
  if (detail) return detail;
  if (params.result.signal) return `signal ${params.result.signal}`;
  return `exit code ${params.result.code ?? "?"}`;
}

async function convertAudioToSilkViaPipe(params: {
  sourcePath: string;
  ffmpegPath: string;
  silkPath: string;
  argTemplates: string[][];
  sampleRate: number;
}): Promise<{ buffer: Buffer; durationMs: number }> {
  const ffmpegArgs = [
    "-y",
    "-i",
    params.sourcePath,
    "-ac",
    "1",
    "-ar",
    String(params.sampleRate),
    "-f",
    "s16le",
    "pipe:1",
  ];
  const ffmpegResult = await runBinaryCommand({
    argv: [params.ffmpegPath, ...ffmpegArgs],
    timeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
  });
  if (ffmpegResult.code !== 0) {
    throw new Error(
      `ffmpeg pipe failed: ${formatBinaryCommandFailure({
        label: "ffmpeg",
        result: ffmpegResult,
      })}`,
    );
  }

  const trimmedPcm = trimPcmBuffer({
    buffer: ffmpegResult.stdout,
    sampleRate: params.sampleRate,
  });

  let lastError: string | null = null;
  for (const template of params.argTemplates) {
    const args = resolveSilkArgs({
      template,
      input: "-",
      output: "-",
      sampleRate: params.sampleRate,
    });
    const result = await runBinaryCommand({
      argv: [params.silkPath, ...args],
      timeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
      input: trimmedPcm.buffer,
    });
    if (result.code === 0 && result.stdout.length > 0) {
      return { buffer: result.stdout, durationMs: trimmedPcm.durationMs };
    }
    lastError =
      result.code === 0
        ? "encoder produced empty stdout"
        : formatBinaryCommandFailure({ label: "silk", result });
  }

  throw new Error(`silk encoder pipe failed (${params.silkPath}): ${lastError ?? "unknown error"}`);
}

async function convertAudioToSilkViaFiles(params: {
  sourcePath: string;
  ffmpegPath: string;
  silkPath: string;
  argTemplates: string[][];
  sampleRate: number;
}): Promise<{ buffer: Buffer; durationMs: number }> {
  const core = getGeweRuntime();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gewe-voice-"));
  const pcmPath = path.join(tmpDir, "voice.pcm");
  const silkOutPath = path.join(tmpDir, "voice.silk");

  try {
    const ffmpegArgs = [
      "-y",
      "-i",
      params.sourcePath,
      "-ac",
      "1",
      "-ar",
      String(params.sampleRate),
      "-f",
      "s16le",
      pcmPath,
    ];
    const ffmpegResult = await core.system.runCommandWithTimeout(
      [params.ffmpegPath, ...ffmpegArgs],
      { timeoutMs: DEFAULT_VOICE_TIMEOUT_MS },
    );
    if (ffmpegResult.code !== 0) {
      throw new Error(
        `ffmpeg failed: code=${ffmpegResult.code ?? "?"} stderr=${ffmpegResult.stderr.trim()}`,
      );
    }

    const trimmedPcm = trimPcmBuffer({
      buffer: await fs.readFile(pcmPath),
      sampleRate: params.sampleRate,
    });
    await fs.writeFile(pcmPath, trimmedPcm.buffer);

    let encoded = false;
    let lastError: string | null = null;
    for (const template of params.argTemplates) {
      const args = resolveSilkArgs({
        template,
        input: pcmPath,
        output: silkOutPath,
        sampleRate: params.sampleRate,
      });
      const result = await core.system.runCommandWithTimeout([params.silkPath, ...args], {
        timeoutMs: DEFAULT_VOICE_TIMEOUT_MS,
      });
      if (result.code === 0) {
        const outStat = await fs.stat(silkOutPath).catch(() => null);
        if (outStat?.isFile()) {
          encoded = true;
          break;
        }
      }
      lastError = result.stderr.trim() || `exit code ${result.code ?? "?"}`;
    }
    if (!encoded) {
      throw new Error(
        `silk encoder failed (${params.silkPath}): ${lastError ?? "unknown error"}`,
      );
    }

    const buffer = await fs.readFile(silkOutPath);
    if (!buffer.length) {
      throw new Error("silk encoder produced empty output");
    }

    return { buffer, durationMs: trimmedPcm.durationMs };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

export async function convertAudioToSilk(params: {
  account: ResolvedGeweAccount;
  sourcePath: string;
}): Promise<{ buffer: Buffer; durationMs: number } | null> {
  const core = getGeweRuntime();
  const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "voice" });
  if (params.account.config.voiceAutoConvert === false) return null;

  const sampleRate = resolveVoiceSampleRate(params.account);
  const ffmpegPath = params.account.config.voiceFfmpegPath?.trim() || DEFAULT_VOICE_FFMPEG;
  const fallbackArgs = [
    ["-i", "{input}", "-o", "{output}", "-rate", "{sampleRate}"],
    ["{input}", "{output}", "-rate", "{sampleRate}"],
    ["{input}", "{output}", "{sampleRate}"],
    ["{input}", "{output}"],
  ];
  const rustArgs = buildRustSilkEncodeArgs({
    input: "{input}",
    output: "{output}",
    sampleRate,
  });
  const customPath = params.account.config.voiceSilkPath?.trim();
  const customArgs =
    params.account.config.voiceSilkArgs?.length ? [params.account.config.voiceSilkArgs] : [];
  let silkPath = customPath || DEFAULT_VOICE_SILK;
  let argTemplates = customArgs.length ? customArgs : fallbackArgs;
  if (!customPath) {
    const rustSilk = await ensureRustSilkBinary(params.account);
    if (rustSilk) {
      silkPath = rustSilk;
      argTemplates = [rustArgs];
    }
  }

  try {
    if (params.account.config.voiceSilkPipe === true) {
      try {
        return await convertAudioToSilkViaPipe({
          sourcePath: params.sourcePath,
          ffmpegPath,
          silkPath,
          argTemplates,
          sampleRate,
        });
      } catch (err) {
        logger.warn?.(`gewe voice pipe convert failed, falling back to temp files: ${String(err)}`);
      }
    }

    return await convertAudioToSilkViaFiles({
      sourcePath: params.sourcePath,
      ffmpegPath,
      silkPath,
      argTemplates,
      sampleRate,
    });
  } catch (err) {
    logger.warn?.(`gewe voice convert failed: ${String(err)}`);
    return null;
  }
}

async function normalizeThumbBuffer(params: {
  buffer: Buffer;
  contentType?: string;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const core = getGeweRuntime();
  const contentType = params.contentType?.split(";")[0]?.trim();
  if (
    params.buffer.byteLength <= LINK_THUMB_MAX_BYTES &&
    contentType &&
    contentType.startsWith("image/")
  ) {
    return { buffer: params.buffer, contentType };
  }

  let working = params.buffer;
  for (const maxSide of [LINK_THUMB_MAX_SIDE, 240, 200, 160]) {
    for (const quality of LINK_THUMB_QUALITY_STEPS) {
      const resized = await core.media.resizeToJpeg({
        buffer: working,
        maxSide,
        quality,
        withoutEnlargement: true,
      });
      if (resized.byteLength <= LINK_THUMB_MAX_BYTES) {
        return { buffer: resized, contentType: "image/jpeg" };
      }
      working = resized;
    }
  }

  return { buffer: working, contentType: "image/jpeg" };
}

async function loadThumbSource(params: {
  url: string;
}): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  const core = getGeweRuntime();
  if (looksLikeHttpUrl(params.url)) {
    return await core.channel.media.fetchRemoteMedia({
      url: params.url,
      maxBytes: LINK_THUMB_FETCH_MAX_BYTES,
      filePathHint: params.url,
    });
  }

  const localPath = normalizeFileUrl(params.url);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) {
    throw new Error("thumbUrl is not a file");
  }
  if (stat.size > LINK_THUMB_FETCH_MAX_BYTES) {
    throw new Error("thumbUrl exceeds 2MB limit");
  }
  const buffer = await fs.readFile(localPath);
  const contentType = await core.media.detectMime({ buffer, filePath: localPath });
  return { buffer, contentType, fileName: path.basename(localPath) };
}

async function stageThumbBuffer(params: {
  account: ResolvedGeweAccount;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}): Promise<string> {
  const core = getGeweRuntime();
  const normalized = await normalizeThumbBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
  });
  if (normalized.buffer.byteLength > LINK_THUMB_MAX_BYTES) {
    throw new Error("link thumbnail exceeds 50KB after resize");
  }

  if (hasS3(params.account)) {
    try {
      const s3Config = resolveS3Config(params.account.config);
      if (!s3Config) throw new Error("s3 not configured");
      const uploaded = await uploadToS3({
        config: s3Config,
        accountId: params.account.accountId,
        buffer: normalized.buffer,
        contentType: normalized.contentType,
        fileName: params.fileName,
      });
      return uploaded.url;
    } catch (err) {
      if (!hasProxyBase(params.account)) {
        throw new Error(`s3 thumb upload failed and proxy fallback unavailable: ${String(err)}`);
      }
      const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "thumb" });
      logger.warn?.(`gewe thumb s3 upload failed, fallback proxy: ${String(err)}`);
    }
  }

  const publicBase = params.account.config.mediaPublicUrl?.trim();
  if (!publicBase) {
    throw new Error("mediaPublicUrl not configured (required for thumbnail fallback)");
  }
  const saved = await core.channel.media.saveMediaBuffer(
    normalized.buffer,
    normalized.contentType,
    "outbound",
    LINK_THUMB_MAX_BYTES,
    params.fileName,
  );
  return buildPublicUrl(publicBase, saved.id);
}

async function resolveLinkThumbUrl(params: {
  account: ResolvedGeweAccount;
  thumbUrl?: string;
}): Promise<string> {
  const core = getGeweRuntime();
  const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "thumb" });
  const fallbackBuffer = await fs.readFile(DEFAULT_LINK_THUMB_PATH);
  const fallbackUrl = await stageThumbBuffer({
    account: params.account,
    buffer: fallbackBuffer,
    contentType: "image/jpeg",
    fileName: "gewe-thumb.jpeg",
  });

  const raw = params.thumbUrl?.trim();
  if (!raw) return fallbackUrl;

  try {
    const source = await loadThumbSource({ url: raw });
    const normalized = await normalizeThumbBuffer({
      buffer: source.buffer,
      contentType: source.contentType,
    });
    if (normalized.buffer.byteLength > LINK_THUMB_MAX_BYTES) {
      return fallbackUrl;
    }
    return await stageThumbBuffer({
      account: params.account,
      buffer: normalized.buffer,
      contentType: normalized.contentType,
      fileName: source.fileName ?? "gewe-thumb.jpeg",
    });
  } catch (err) {
    logger.warn?.(`gewe link thumb fallback: ${String(err)}`);
    return fallbackUrl;
  }
}

function normalizeMediaToken(raw: string): string {
  let value = raw.trim();
  if (value.toUpperCase().startsWith("MEDIA:")) {
    value = value.slice("MEDIA:".length).trim();
  }
  if (
    (value.startsWith("`") && value.endsWith("`")) ||
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function md5Hex(value: string): string {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function buildPartialQuoteXml(params?: {
  text?: string;
  start?: string;
  end?: string;
  startIndex?: string | number;
  endIndex?: string | number;
  quoteMd5?: string;
}): string {
  if (!params) return "";
  const text = params.text?.trim();
  const start = (params.start?.trim() || text?.slice(0, 1) || "").trim();
  const end = (params.end?.trim() || text?.slice(-1) || "").trim();
  const quoteMd5 = (params.quoteMd5?.trim() || (text ? md5Hex(text) : "")).toLowerCase();
  if (!start || !end || !quoteMd5) return "";

  const startIndex =
    params.startIndex != null && String(params.startIndex).trim()
      ? String(params.startIndex).trim()
      : "0";
  const endIndex =
    params.endIndex != null && String(params.endIndex).trim()
      ? String(params.endIndex).trim()
      : "0";

  return `<partialtext><start>${escapeXmlText(start)}</start><end>${escapeXmlText(end)}</end><startindex>${escapeXmlText(startIndex)}</startindex><endindex>${escapeXmlText(endIndex)}</endindex><quotemd5>${escapeXmlText(quoteMd5)}</quotemd5></partialtext>`;
}

function buildQuoteReplyAppMsg(params: {
  title: string;
  svrid: string;
  atWxid?: string;
  partialText?: {
    text?: string;
    start?: string;
    end?: string;
    startIndex?: string | number;
    endIndex?: string | number;
    quoteMd5?: string;
  };
}): string {
  const safeTitle = escapeXmlText(params.title.trim() || "引用回复");
  const safeSvrid = escapeXmlText(params.svrid.trim());

  const partialTextXml = buildPartialQuoteXml(params.partialText);
  return `<appmsg><title>${safeTitle}</title><type>57</type><refermsg>${partialTextXml}<svrid>${safeSvrid}</svrid></refermsg></appmsg>`;
}
function summarizeOutboundText(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, 120));
}
async function stageMedia(params: {
  account: ResolvedGeweAccount;
  cfg: OpenClawConfig;
  mediaUrl: string;
  allowRemote: boolean;
}): Promise<ResolvedMedia> {
  const core = getGeweRuntime();
  const rawUrl = normalizeMediaToken(params.mediaUrl);
  if (!rawUrl) throw new Error("mediaUrl is empty");
  const isRemote = looksLikeHttpUrl(rawUrl);
  if (isRemote && params.allowRemote) {
    const contentType = await core.media.detectMime({ filePath: rawUrl });
    const fileName = path.basename(new URL(rawUrl).pathname || "");

    // 对于远程图片，下载后转换为 base64
    try {
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: rawUrl,
        maxBytes: resolveMediaMaxBytes(params.account),
        filePathHint: rawUrl,
      });
      let base64 = fetched.buffer.toString("base64");

      if (!fetched.buffer || fetched.buffer.length === 0) {
        // 使用默认图片
        base64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCARlBGUDASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAYHAQUIBAID/8QAWBAAAQMDAQQDCggLBgQFBAEFAAECAwQFEQYHEiExE0FRFBYXMlVhcZOx0RUiNTZ0gZGyIzM0U1Ryc5KhwtJCUqPB4fCCg5SzJkNiZKQkJTdERfEnY6Li/8QAGgEBAAIDAQAAAAAAAAAAAAAAAAQFAQIDBv/EAC0RAAICAgEEAQQDAAIDAQEAAAABAgMEERIFEyExURQyM0EVIlIjkTRCcYFh/9oADAMBAAIRAxEAPwDqhvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAA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'
      } else {
        //base64去掉前半段
        base64 = base64.replace(/^data:image\/\w+;base64,/, "");
      }


      return {
        publicUrl: rawUrl,
        base64,
        contentType: contentType ?? fetched.contentType ?? undefined,
        fileName: fileName || fetched.fileName,
        sourceKind: "remote",
        sourceUrl: rawUrl,
        provider: "direct",
      };
    } catch {
      // 下载失败时使用默认图片
      const defaultBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCARlBGUDASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAYHAQUIBAID/8QAWBAAAQMDAQQDCggLBgQFBAEFAAECAwQFEQYHEiExE0FRFBYXMlVhcZOx0RUiNTZ0gZGyIzM0U1Ryc5KhwtJCUqPB4fCCg5SzJkNiZKQkJTdERfEnY6Li/8QAGgEBAAIDAQAAAAAAAAAAAAAAAAQFAQIDBv/EAC0RAAICAgEEAQQDAAIDAQEAAAABAgMEERIFEyExURQyM0EVIlIjkTRCcYFh/9oADAMBAAIRAxEAPwDqhvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPl3UA7qABlvJDJhvJDIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8u6gHdQAMt5IZMN5IZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      return {
        publicUrl: rawUrl,
        base64: defaultBase64,
        contentType: contentType ?? undefined,
        fileName,
        sourceKind: "remote",
        sourceUrl: rawUrl,
        provider: "direct",
      };
    }
  }

  const maxBytes = resolveMediaMaxBytes(params.account);
  let buffer: Buffer;
  let contentType: string | undefined;
  let fileName: string | undefined;
  let sourceLocalPath: string | undefined;

  if (isRemote) {
    const fetched = await core.channel.media.fetchRemoteMedia({
      url: rawUrl,
      maxBytes,
      filePathHint: rawUrl,
    });
    buffer = fetched.buffer;
    contentType = fetched.contentType ?? undefined;
    fileName = fetched.fileName;
  } else {
    const localPath = normalizeFileUrl(rawUrl);
    buffer = await fs.readFile(localPath);
    contentType = await core.media.detectMime({ buffer, filePath: localPath });
    fileName = path.basename(localPath);
    sourceLocalPath = localPath;
  }

  const base64 = buffer.toString("base64");

  if (hasS3(params.account)) {
    try {
      const s3Config = resolveS3Config(params.account.config);
      if (!s3Config) throw new Error("s3 not configured");
      const uploaded = await uploadToS3({
        config: s3Config,
        accountId: params.account.accountId,
        buffer,
        contentType,
        fileName,
      });
      return {
        publicUrl: uploaded.url,
        base64,
        contentType,
        fileName,
        localPath: sourceLocalPath,
        sourceKind: isRemote ? "remote" : "local",
        sourceUrl: rawUrl,
        provider: "s3",
      };
    } catch (err) {
      if (!hasProxyBase(params.account)) {
        throw new Error(`s3 upload failed and proxy fallback unavailable: ${String(err)}`);
      }
      const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "media" });
      logger.warn?.(`gewe s3 upload failed, fallback to proxy: ${String(err)}`);
    }
  }

  const publicBase = params.account.config.mediaPublicUrl?.trim();
  if (!publicBase) {
    throw new Error("mediaPublicUrl not configured (required for proxy fallback)");
  }

  const saved = await core.channel.media.saveMediaBuffer(
    buffer,
    contentType,
    "outbound",
    maxBytes,
    fileName,
  );
  const resolvedFileName = fileName || extractOriginalFilename(saved.path);
  let resolvedId = saved.id;
  let resolvedPath = saved.path;
  const desiredExt =
    extensionForMime(contentType ?? saved.contentType) || path.extname(resolvedFileName);
  if (desiredExt && !path.extname(resolvedId)) {
    const nextId = `${resolvedId}${desiredExt}`;
    const nextPath = path.join(path.dirname(saved.path), nextId);
    await fs.rename(saved.path, nextPath).catch(() => { });
    resolvedId = nextId;
    resolvedPath = nextPath;
  }
  return {
    publicUrl: buildPublicUrl(publicBase, resolvedId),
    base64,
    contentType: contentType ?? saved.contentType,
    fileName: resolvedFileName || resolvedId,
    localPath: sourceLocalPath ?? resolvedPath,
    sourceKind: isRemote ? "remote" : "local",
    sourceUrl: rawUrl,
    provider: "proxy",
  };
}

async function resolvePublicUrl(params: {
  account: ResolvedGeweAccount;
  cfg: OpenClawConfig;
  url: string;
  allowRemote: boolean;
}): Promise<string> {
  const staged = await stageMedia({
    account: params.account,
    cfg: params.cfg,
    mediaUrl: params.url,
    allowRemote: params.allowRemote,
  });
  return staged.publicUrl;
}

function shouldRetryWithStagedFallback(params: {
  originalUrl: string;
  staged: ResolvedMedia;
  account: ResolvedGeweAccount;
}): boolean {
  if (!looksLikeHttpUrl(params.originalUrl)) return false;
  if (params.staged.provider !== "direct") return false;
  return resolveFallbackProviders(params.account).length > 0;
}

async function stageFallbackFromRemote(params: {
  account: ResolvedGeweAccount;
  cfg: OpenClawConfig;
  originalUrl: string;
}): Promise<ResolvedMedia> {
  return await stageMedia({
    account: params.account,
    cfg: params.cfg,
    mediaUrl: params.originalUrl,
    allowRemote: false,
  });
}

export async function deliverGewePayload(params: {
  payload: ReplyPayload;
  account: ResolvedGeweAccount;
  cfg: OpenClawConfig;
  toWxid: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<GeweSendResult | null> {
  const { payload, account, cfg, toWxid, statusSink } = params;
  const core = getGeweRuntime();
  const geweData = resolveGeweData(payload);

  const trimmedText = payload.text?.trim() ?? "";
  const mediaUrl =
    payload.mediaUrl?.trim() || payload.mediaUrls?.[0]?.trim() || "";
  const normalizedMediaUrl = normalizeMediaToken(mediaUrl);
  const autoQuoteContext =
    trimmedText && payload.replyToId?.trim() && !mediaUrl
      ? recallGeweQuoteReplyContext({
        accountId: account.accountId,
        messageId: payload.replyToId,
      })
      : null;
  const autoQuoteReplyEnabled = account.config.autoQuoteReply !== false;

  if (geweData?.appMsg?.appmsg?.trim()) {
    const result = await sendAppMsgGewe({
      account,
      toWxid,
      appmsg: geweData.appMsg.appmsg.trim(),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  const quoteReplySvrid =
    geweData?.quoteReply?.svrid != null
      ? String(geweData.quoteReply.svrid).trim()
      : payload.replyToId?.trim() || "";
  const quoteReplyTitle = geweData?.quoteReply?.title?.trim() || trimmedText;
  if (quoteReplySvrid && quoteReplyTitle && geweData?.quoteReply) {
    core.log?.(
      `gewe: outbound quoteReply explicit to=${toWxid} ats=${JSON.stringify(geweData.quoteReply.atWxid?.trim() || "")} title=${summarizeOutboundText(quoteReplyTitle)}`,
    );
    const result = await sendAppMsgGewe({
      account,
      toWxid,
      appmsg: buildQuoteReplyAppMsg({
        svrid: quoteReplySvrid,
        title: quoteReplyTitle,
        atWxid: geweData.quoteReply.atWxid?.trim(),
        partialText: geweData.quoteReply.partialText,
      }),
      ats: geweData.quoteReply.atWxid?.trim(),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (geweData?.emoji?.emojiMd5?.trim() && typeof geweData.emoji.emojiSize === "number") {
    const result = await sendEmojiGewe({
      account,
      toWxid,
      emojiMd5: geweData.emoji.emojiMd5.trim(),
      emojiSize: Math.floor(geweData.emoji.emojiSize),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (geweData?.nameCard?.nickName?.trim() && geweData.nameCard.nameCardWxid?.trim()) {
    const result = await sendNameCardGewe({
      account,
      toWxid,
      nickName: geweData.nameCard.nickName.trim(),
      nameCardWxid: geweData.nameCard.nameCardWxid.trim(),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (
    geweData?.miniApp?.miniAppId?.trim() &&
    geweData.miniApp.displayName?.trim() &&
    geweData.miniApp.pagePath?.trim() &&
    geweData.miniApp.coverImgUrl?.trim() &&
    geweData.miniApp.title?.trim() &&
    geweData.miniApp.userName?.trim()
  ) {
    const result = await sendMiniAppGewe({
      account,
      toWxid,
      miniAppId: geweData.miniApp.miniAppId.trim(),
      displayName: geweData.miniApp.displayName.trim(),
      pagePath: geweData.miniApp.pagePath.trim(),
      coverImgUrl: geweData.miniApp.coverImgUrl.trim(),
      title: geweData.miniApp.title.trim(),
      userName: geweData.miniApp.userName.trim(),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (
    geweData?.revoke?.msgId != null &&
    geweData.revoke.newMsgId != null &&
    geweData.revoke.createTime != null
  ) {
    const result = await revokeMessageGewe({
      account,
      toWxid,
      msgId: String(geweData.revoke.msgId).trim(),
      newMsgId: String(geweData.revoke.newMsgId).trim(),
      createTime: String(geweData.revoke.createTime).trim(),
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (geweData?.forward?.kind && geweData.forward.xml?.trim()) {
    let result: GeweSendResult | null = null;
    switch (geweData.forward.kind) {
      case "image":
        result = await forwardImageGewe({
          account,
          toWxid,
          xml: geweData.forward.xml.trim(),
        });
        break;
      case "video":
        result = await forwardVideoGewe({
          account,
          toWxid,
          xml: geweData.forward.xml.trim(),
        });
        break;
      case "file":
        result = await forwardFileGewe({
          account,
          toWxid,
          xml: geweData.forward.xml.trim(),
        });
        break;
      case "link":
        result = await forwardLinkGewe({
          account,
          toWxid,
          xml: geweData.forward.xml.trim(),
        });
        break;
      case "miniApp":
        if (!geweData.forward.coverImgUrl?.trim()) {
          break;
        }
        result = await forwardMiniAppGewe({
          account,
          toWxid,
          xml: geweData.forward.xml.trim(),
          coverImgUrl: geweData.forward.coverImgUrl.trim(),
        });
        break;
    }
    if (result) {
      core.channel.activity.record({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        direction: "outbound",
      });
      statusSink?.({ lastOutboundAt: Date.now() });
      return result;
    }
  }

  if (geweData?.link) {
    const link = geweData.link;
    const thumbUrl = await resolveLinkThumbUrl({
      account,
      thumbUrl: link.thumbUrl,
    });
    const result = await sendLinkGewe({
      account,
      toWxid,
      title: link.title,
      desc: link.desc,
      linkUrl: link.linkUrl,
      thumbUrl,
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (autoQuoteReplyEnabled && trimmedText && payload.replyToId?.trim() && !mediaUrl) {
    core.log?.(
      `gewe: outbound quoteReply auto to=${toWxid} ats=${JSON.stringify(geweData?.ats?.trim() || "")} title=${summarizeOutboundText(trimmedText)}`,
    );
    const result = await sendAppMsgGewe({
      account,
      toWxid,
      appmsg: buildQuoteReplyAppMsg({
        svrid: autoQuoteContext?.svrid ?? payload.replyToId.trim(),
        title: trimmedText,
        partialText: autoQuoteContext?.partialText,
      }),
      ats: geweData?.ats,
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (mediaUrl) {
    const audioAsVoice = payload.audioAsVoice === true;
    const forceFile = geweData?.forceFile === true;
    const ttsVoiceHint = !forceFile && looksLikeTtsVoiceMediaUrl(normalizedMediaUrl);
    const wantsVoice = !forceFile && (audioAsVoice || ttsVoiceHint);
    const staged = await stageMedia({
      account,
      cfg,
      mediaUrl: normalizedMediaUrl,
      allowRemote: !wantsVoice,
    });
    const contentType = staged.contentType;
    const fileName = staged.fileName;
    const kind = core.media.mediaKindFromMime(contentType);

    if (wantsVoice && kind === "audio") {
      const declaredDuration = resolveVoiceDurationMs(geweData);
      if (isSilkAudio({ contentType, fileName })) {
        if (declaredDuration) {
          let result: GeweSendResult;
          try {
            result = await sendVoiceGewe({
              account,
              toWxid,
              voiceUrl: staged.publicUrl,
              voiceDuration: declaredDuration,
            });
          } catch (err) {
            if (!shouldRetryWithStagedFallback({
              originalUrl: normalizedMediaUrl,
              staged,
              account,
            })) {
              throw err;
            }
            const fallback = await stageFallbackFromRemote({
              account,
              cfg,
              originalUrl: normalizedMediaUrl,
            });
            result = await sendVoiceGewe({
              account,
              toWxid,
              voiceUrl: fallback.publicUrl,
              voiceDuration: declaredDuration,
            });
          }
          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            direction: "outbound",
          });
          statusSink?.({ lastOutboundAt: Date.now() });
          return result;
        }
      } else if (staged.localPath) {
        const converted = await convertAudioToSilk({
          account,
          sourcePath: staged.localPath,
        });
        if (converted) {
          const voiceDuration = declaredDuration ?? converted.durationMs;
          let voiceUrl: string;
          if (hasS3(account)) {
            try {
              const s3Config = resolveS3Config(account.config);
              if (!s3Config) throw new Error("s3 not configured");
              const uploaded = await uploadToS3({
                config: s3Config,
                accountId: account.accountId,
                buffer: converted.buffer,
                contentType: "audio/silk",
                fileName: "voice.silk",
              });
              voiceUrl = uploaded.url;
            } catch (err) {
              if (!hasProxyBase(account)) {
                throw new Error(
                  `s3 silk upload failed and proxy fallback unavailable: ${String(err)}`,
                );
              }
              const publicBase = account.config.mediaPublicUrl?.trim();
              if (!publicBase) {
                throw new Error("mediaPublicUrl not configured (required for silk voice)");
              }
              const saved = await core.channel.media.saveMediaBuffer(
                converted.buffer,
                "audio/silk",
                "outbound",
                resolveMediaMaxBytes(account),
                "voice.silk",
              );
              voiceUrl = buildPublicUrl(publicBase, saved.id);
            }
          } else {
            const publicBase = account.config.mediaPublicUrl?.trim();
            if (!publicBase) {
              throw new Error("mediaPublicUrl not configured (required for silk voice)");
            }
            const saved = await core.channel.media.saveMediaBuffer(
              converted.buffer,
              "audio/silk",
              "outbound",
              resolveMediaMaxBytes(account),
              "voice.silk",
            );
            voiceUrl = buildPublicUrl(publicBase, saved.id);
          }
          const result = await sendVoiceGewe({
            account,
            toWxid,
            voiceUrl,
            voiceDuration,
          });
          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            direction: "outbound",
          });
          statusSink?.({ lastOutboundAt: Date.now() });
          return result;
        }
      }
    }

    if (!forceFile && kind === "image") {
      let result: GeweSendResult;
      try {
        result = await sendImageGewe({
          account,
          toWxid,
          imgBase64: staged.base64,
          imgUrl: staged.publicUrl,
        });
      } catch (err) {
        if (!shouldRetryWithStagedFallback({
          originalUrl: normalizedMediaUrl,
          staged,
          account,
        })) {
          throw err;
        }
        const fallback = await stageFallbackFromRemote({
          account,
          cfg,
          originalUrl: normalizedMediaUrl,
        });
        result = await sendImageGewe({
          account,
          toWxid,
          imgBase64: fallback.base64,
          imgUrl: fallback.publicUrl,
        });
      }
      core.channel.activity.record({
        channel: CHANNEL_ID,
        accountId: account.accountId,
        direction: "outbound",
      });
      statusSink?.({ lastOutboundAt: Date.now() });
      return result;
    }

    if (!forceFile && kind === "video") {
      const logger = core.logging.getChildLogger({ channel: CHANNEL_ID, module: "video" });
      const video = geweData?.video;
      let thumbUrl = video?.thumbUrl;
      const fallbackThumbUrl = account.config.videoThumbUrl?.trim() || undefined;
      let videoDuration =
        typeof video?.videoDuration === "number" ? Math.floor(video.videoDuration) : undefined;
      let stagedVideo = staged;

      if ((!thumbUrl || typeof videoDuration !== "number") && !stagedVideo.localPath) {
        try {
          stagedVideo = await stageMedia({
            account,
            cfg,
            mediaUrl,
            allowRemote: false,
          });
        } catch {
          // ignore; we'll fall back to file send below
        }
      }

      if (typeof videoDuration !== "number" && stagedVideo.localPath) {
        const probed = await probeVideoDurationSeconds({
          account,
          sourcePath: stagedVideo.localPath,
        });
        if (typeof probed === "number") {
          videoDuration = probed;
        }
      }

      if (!thumbUrl && stagedVideo.localPath) {
        const buffer = await generateVideoThumbBuffer({
          account,
          sourcePath: stagedVideo.localPath,
        });
        if (buffer) {
          const normalized = await normalizeThumbBuffer({
            buffer,
            contentType: "image/png",
          });
          if (normalized.buffer.byteLength <= LINK_THUMB_MAX_BYTES) {
            thumbUrl = await stageThumbBuffer({
              account,
              buffer: normalized.buffer,
              contentType: normalized.contentType,
              fileName: "gewe-video-thumb.png",
            });
          }
        }
      }

      if (!thumbUrl && fallbackThumbUrl) {
        thumbUrl = fallbackThumbUrl;
      }

      if (thumbUrl && typeof videoDuration === "number") {
        const thumbPublicUrl = await resolvePublicUrl({
          account,
          cfg,
          url: thumbUrl,
          allowRemote: true,
        });
        const canRetryMediaFallback = shouldRetryWithStagedFallback({
          originalUrl: normalizedMediaUrl,
          staged: stagedVideo,
          account,
        });
        try {
          const result = await sendVideoGewe({
            account,
            toWxid,
            videoUrl: stagedVideo.publicUrl,
            thumbUrl: thumbPublicUrl,
            videoDuration: Math.floor(videoDuration),
          });
          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            direction: "outbound",
          });
          statusSink?.({ lastOutboundAt: Date.now() });
          return result;
        } catch (err) {
          if (canRetryMediaFallback) {
            const fallbackVideo = await stageFallbackFromRemote({
              account,
              cfg,
              originalUrl: normalizedMediaUrl,
            });
            const fallbackThumb = await resolvePublicUrl({
              account,
              cfg,
              url: thumbUrl,
              allowRemote: false,
            });
            const result = await sendVideoGewe({
              account,
              toWxid,
              videoUrl: fallbackVideo.publicUrl,
              thumbUrl: fallbackThumb,
              videoDuration: Math.floor(videoDuration),
            });
            core.channel.activity.record({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              direction: "outbound",
            });
            statusSink?.({ lastOutboundAt: Date.now() });
            return result;
          }
          if (fallbackThumbUrl && fallbackThumbUrl !== thumbUrl) {
            logger.warn?.(
              `gewe video send failed with primary thumb, retrying fallback: ${String(err)}`,
            );
            const fallbackPublicUrl = await resolvePublicUrl({
              account,
              cfg,
              url: fallbackThumbUrl,
              allowRemote: true,
            });
            const result = await sendVideoGewe({
              account,
              toWxid,
              videoUrl: stagedVideo.publicUrl,
              thumbUrl: fallbackPublicUrl,
              videoDuration: Math.floor(videoDuration),
            });
            core.channel.activity.record({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              direction: "outbound",
            });
            statusSink?.({ lastOutboundAt: Date.now() });
            return result;
          }
          throw err;
        }
      }
    }

    const fallbackName =
      geweData?.fileName ||
      fileName ||
      (contentType ? `file${contentType.includes("/") ? `.${contentType.split("/")[1]}` : ""}` : "file");
    let result: GeweSendResult;
    try {
      result = await sendFileGewe({
        account,
        toWxid,
        fileUrl: staged.publicUrl,
        fileName: fallbackName,
      });
    } catch (err) {
      if (!shouldRetryWithStagedFallback({
        originalUrl: normalizedMediaUrl,
        staged,
        account,
      })) {
        throw err;
      }
      const fallback = await stageFallbackFromRemote({
        account,
        cfg,
        originalUrl: normalizedMediaUrl,
      });
      result = await sendFileGewe({
        account,
        toWxid,
        fileUrl: fallback.publicUrl,
        fileName: fallbackName,
      });
    }
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  if (trimmedText) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
    });
    const content = core.channel.text.convertMarkdownTables(trimmedText, tableMode);
    const result = await sendTextGewe({
      account,
      toWxid,
      content,
      ats: geweData?.ats,
    });
    core.channel.activity.record({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      direction: "outbound",
    });
    statusSink?.({ lastOutboundAt: Date.now() });
    return result;
  }

  return null;
}


