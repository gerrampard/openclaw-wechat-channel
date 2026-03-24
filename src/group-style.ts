/**
 * 群风格自动学习系统 v1
 *
 * 功能：收集群聊消息统计 → 推断群风格画像
 * 存储：本地 JSON 文件  {baseDir}/memory/group-style/{groupId}.json
 * 策略：每 50 条消息或每 10 分钟重算一次 profile
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  GroupStyleData,
  GroupStyleProfile,
  GroupStyleRawStats,
  HourlyStats,
  KeywordCounts,
  ReplyLength,
  Seriousness,
  SpeakFrequency,
  Tone,
} from "./group-style-types.js";

// ─── 常量 ───────────────────────────────────────────────

/** 最少消息数才启用风格画像 */
const MIN_MESSAGES_FOR_PROFILE = 50;

/** 每隔多少条消息重算一次 */
const RECALC_MESSAGE_INTERVAL = 50;

/** 最短重算间隔（ms），10 分钟 */
const RECALC_TIME_INTERVAL_MS = 10 * 60 * 1000;

/** 关键词保留的 top N */
const TOP_KEYWORDS_COUNT = 20;

/** 关键词计数表最大保留数（防止无限增长） */
const MAX_KEYWORD_ENTRIES = 500;

// ─── Emoji 正则 ─────────────────────────────────────────

const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/u;

// ─── 疑问词 ─────────────────────────────────────────────

const QUESTION_MARKERS = [
  "?", "？", "吗", "呢", "么", "嘛", "啥", "什么", "为什么",
  "怎么", "如何", "哪", "几", "多少", "是否", "能否", "可以吗",
  "有没有", "是不是",
];

// ─── 停用词（轻量版） ───────────────────────────────────

const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她",
  "吗", "呢", "啊", "哦", "嗯", "哈", "呀", "吧", "嘿", "喂",
  "那", "还", "把", "被", "让", "给", "从", "但", "而", "或",
  "如果", "所以", "因为", "这个", "那个", "什么", "怎么", "可以",
  "没", "对", "做", "能", "来", "过", "下", "它", "们", "为",
  "大", "小", "多", "少", "些", "里", "个", "中", "后", "前",
]);

// ─── 内存缓存 ───────────────────────────────────────────

const styleCache = new Map<string, GroupStyleData>();

// ─── 公共 API ───────────────────────────────────────────

/**
 * 处理一条群聊消息，更新风格统计
 * 在 saveMessageToFile 之后调用即可
 */
export function feedGroupStyleMessage(params: {
  groupId: string;
  content: string;
  timestamp: number;
  isMe: boolean;
  baseDir: string;
}): void {
  const { groupId, content, timestamp, isMe, baseDir } = params;

  // 跳过机器人自身消息
  if (isMe) return;
  // 跳过空内容
  if (!content || !content.trim()) return;
  // 只处理群聊
  if (!groupId.endsWith("@chatroom")) return;

  const text = content.trim();
  const styleDir = resolveStyleDir(baseDir);
  const data = loadStyleData(groupId, styleDir);

  // 更新原始统计
  updateRawStats(data.raw, text, timestamp);

  // 判断是否需要重算 profile
  const needRecalc = shouldRecalcProfile(data.raw);
  if (needRecalc) {
    data.profile = buildProfile(data.raw);
    data.raw.lastProfileAt = data.raw.messageCount;
    data.raw.lastProfileTime = Date.now();
  }

  // 持久化
  saveStyleData(groupId, data, styleDir);
}

/**
 * 获取群风格画像（如果已达阈值）
 */
export function getGroupStyleProfile(
  groupId: string,
  baseDir: string,
): GroupStyleProfile | null {
  const styleDir = resolveStyleDir(baseDir);
  const data = loadStyleData(groupId, styleDir);
  return data.profile;
}

/**
 * 获取群原始统计
 */
export function getGroupStyleRaw(
  groupId: string,
  baseDir: string,
): GroupStyleRawStats | null {
  const styleDir = resolveStyleDir(baseDir);
  const data = loadStyleData(groupId, styleDir);
  return data.raw.messageCount > 0 ? data.raw : null;
}

// ─── 内部实现 ───────────────────────────────────────────

function resolveStyleDir(baseDir: string): string {
  return join(baseDir, "memory", "group-style");
}

function styleFilePath(groupId: string, styleDir: string): string {
  return join(styleDir, `${groupId}.json`);
}

/** 从缓存或文件加载 */
function loadStyleData(groupId: string, styleDir: string): GroupStyleData {
  const cached = styleCache.get(groupId);
  if (cached) return cached;

  const filePath = styleFilePath(groupId, styleDir);
  let data: GroupStyleData;

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      data = JSON.parse(raw) as GroupStyleData;
      // 兼容旧文件缺少字段
      if (!data.raw) data = createEmptyData(groupId);
    } catch {
      data = createEmptyData(groupId);
    }
  } else {
    data = createEmptyData(groupId);
  }

  styleCache.set(groupId, data);
  return data;
}

/** 持久化到文件 + 更新缓存 */
function saveStyleData(groupId: string, data: GroupStyleData, styleDir: string): void {
  styleCache.set(groupId, data);
  try {
    mkdirSync(styleDir, { recursive: true });
    const filePath = styleFilePath(groupId, styleDir);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[group-style] 保存失败 ${groupId}:`, err);
  }
}

function createEmptyData(groupId: string): GroupStyleData {
  return {
    raw: {
      groupId,
      messageCount: 0,
      totalLength: 0,
      emojiCount: 0,
      questionCount: 0,
      shortMsgCount: 0,
      longMsgCount: 0,
      hourlyStats: {},
      keywordCounts: {},
      lastProfileAt: 0,
      lastProfileTime: 0,
      updatedAt: Date.now(),
    },
    profile: null,
  };
}

// ─── 统计更新 ───────────────────────────────────────────

function updateRawStats(raw: GroupStyleRawStats, text: string, timestamp: number): void {
  raw.messageCount++;
  raw.totalLength += text.length;
  raw.updatedAt = Date.now();

  // emoji
  if (EMOJI_REGEX.test(text)) {
    raw.emojiCount++;
  }

  // 疑问
  if (QUESTION_MARKERS.some((m) => text.includes(m))) {
    raw.questionCount++;
  }

  // 短消息
  if (text.length <= 10) {
    raw.shortMsgCount++;
  }

  // 长消息
  if (text.length >= 50) {
    raw.longMsgCount++;
  }

  // 活跃时段
  const hour = new Date(timestamp).getHours();
  raw.hourlyStats[hour] = (raw.hourlyStats[hour] || 0) + 1;

  // 关键词
  updateKeywords(raw.keywordCounts, text);
}

// ─── 轻量中文关键词提取 ─────────────────────────────────

function updateKeywords(counts: KeywordCounts, text: string): void {
  const words = extractChineseKeywords(text);
  for (const w of words) {
    counts[w] = (counts[w] || 0) + 1;
  }

  // 限制条目数：淘汰低频词
  const keys = Object.keys(counts);
  if (keys.length > MAX_KEYWORD_ENTRIES) {
    const sorted = keys.sort((a, b) => counts[a] - counts[b]);
    const toRemove = sorted.slice(0, keys.length - MAX_KEYWORD_ENTRIES);
    for (const k of toRemove) {
      delete counts[k];
    }
  }
}

/**
 * 轻量中文关键词提取
 * 策略：用标点/空格/数字/特殊字符切分 → 取连续中文片段 → 切成 2~6 字的 n-gram
 */
function extractChineseKeywords(text: string): string[] {
  // 去除 emoji 和特殊字符，按非中文字符切分
  const segments = text
    .replace(EMOJI_REGEX, " ")
    .split(/[^\u4e00-\u9fff]+/)
    .filter((s) => s.length >= 2);

  const words: string[] = [];

  for (const seg of segments) {
    if (seg.length <= 6) {
      // 短片段直接作为关键词
      if (!STOP_WORDS.has(seg)) {
        words.push(seg);
      }
    } else {
      // 长片段切成 2~4 字的窗口
      for (let len = 2; len <= Math.min(4, seg.length); len++) {
        for (let i = 0; i <= seg.length - len; i++) {
          const w = seg.slice(i, i + len);
          if (!STOP_WORDS.has(w)) {
            words.push(w);
          }
        }
      }
    }
  }

  return words;
}

// ─── 是否需要重算 profile ────────────────────────────────

function shouldRecalcProfile(raw: GroupStyleRawStats): boolean {
  if (raw.messageCount < MIN_MESSAGES_FOR_PROFILE) return false;

  const messageDelta = raw.messageCount - raw.lastProfileAt;
  const timeDelta = Date.now() - raw.lastProfileTime;

  // 首次达到阈值
  if (raw.lastProfileAt === 0) return true;

  // 每 50 条或每 10 分钟
  return messageDelta >= RECALC_MESSAGE_INTERVAL || timeDelta >= RECALC_TIME_INTERVAL_MS;
}

// ─── 风格推断 ───────────────────────────────────────────

function buildProfile(raw: GroupStyleRawStats): GroupStyleProfile {
  const mc = raw.messageCount;
  const avgLength = mc > 0 ? raw.totalLength / mc : 0;
  const emojiRate = mc > 0 ? raw.emojiCount / mc : 0;
  const questionRate = mc > 0 ? raw.questionCount / mc : 0;
  const shortMsgRate = mc > 0 ? raw.shortMsgCount / mc : 0;
  const longMsgRate = mc > 0 ? raw.longMsgCount / mc : 0;

  // top 活跃时段（取前 3）
  const topActiveHours = Object.entries(raw.hourlyStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => Number(h));

  // top 关键词（取前 15）
  const topKeywords = Object.entries(raw.keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w);

  // ─── 规则推断 ─────────────────────────────

  const replyLength: ReplyLength =
    avgLength < 20 ? "short" : avgLength < 40 ? "normal" : "long";

  const allowEmoji = emojiRate > 0.2;

  let tone: Tone = "neutral";
  if (emojiRate > 0.2 && shortMsgRate > 0.5) {
    tone = "casual";
  } else if (questionRate > 0.3 && longMsgRate > 0.2) {
    tone = "serious";
  }

  const speakFrequency: SpeakFrequency = shortMsgRate > 0.6 ? "low" : "normal";

  let seriousness: Seriousness = "low";
  if (questionRate > 0.45) {
    seriousness = "high";
  } else if (questionRate > 0.2) {
    seriousness = "medium";
  }

  return {
    groupId: raw.groupId,
    messageCount: mc,
    avgLength: Math.round(avgLength * 10) / 10,
    emojiRate: Math.round(emojiRate * 1000) / 1000,
    questionRate: Math.round(questionRate * 1000) / 1000,
    shortMsgRate: Math.round(shortMsgRate * 1000) / 1000,
    longMsgRate: Math.round(longMsgRate * 1000) / 1000,
    topActiveHours,
    topKeywords,
    replyLength,
    allowEmoji,
    tone,
    speakFrequency,
    seriousness,
    generatedAt: Date.now(),
  };
}
