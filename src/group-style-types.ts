/**
 * 群风格自动学习系统 v1 — 类型定义
 */

/** 每小时消息数统计 (0-23) */
export type HourlyStats = Record<number, number>;

/** 关键词计数 */
export type KeywordCounts = Record<string, number>;

/** 群风格原始统计数据（持久化存储） */
export interface GroupStyleRawStats {
  groupId: string;
  /** 有效消息总数（排除 isMe） */
  messageCount: number;
  /** 消息总长度（用于计算平均值） */
  totalLength: number;
  /** 包含 emoji 的消息数 */
  emojiCount: number;
  /** 包含疑问词/问号的消息数 */
  questionCount: number;
  /** 短消息数 (length <= 10) */
  shortMsgCount: number;
  /** 长消息数 (length >= 50) */
  longMsgCount: number;
  /** 每小时消息数 */
  hourlyStats: HourlyStats;
  /** 关键词计数（最近） */
  keywordCounts: KeywordCounts;
  /** 上次重算 style_profile 时的 messageCount */
  lastProfileAt: number;
  /** 上次重算 style_profile 的时间戳 */
  lastProfileTime: number;
  /** 最后更新时间 */
  updatedAt: number;
}

/** 回复长度偏好 */
export type ReplyLength = "short" | "normal" | "long";

/** 语气风格 */
export type Tone = "casual" | "serious" | "neutral";

/** 发言频率 */
export type SpeakFrequency = "low" | "normal";

/** 严肃程度 */
export type Seriousness = "high" | "medium" | "low";

/** 风格画像（由规则推断） */
export interface GroupStyleProfile {
  groupId: string;
  messageCount: number;
  avgLength: number;
  emojiRate: number;
  questionRate: number;
  shortMsgRate: number;
  longMsgRate: number;
  topActiveHours: number[];
  topKeywords: string[];
  /** 推断结果 */
  replyLength: ReplyLength;
  allowEmoji: boolean;
  tone: Tone;
  speakFrequency: SpeakFrequency;
  seriousness: Seriousness;
  /** 生成时间 */
  generatedAt: number;
}

/** 持久化文件结构 */
export interface GroupStyleData {
  raw: GroupStyleRawStats;
  profile: GroupStyleProfile | null;
}
