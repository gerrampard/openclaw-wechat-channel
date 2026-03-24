import type {
  GeweGroupAccessMode,
  GeweGroupConfig,
  GeweGroupSimpleTrigger,
  GeweGroupTriggerMode,
  ResolvedGeweAccount,
  ResolvedGeweGroupReplyMode,
} from "./types.js";
import {
  resolveGeweAllowlistMatch,
  resolveGeweGroupMatch,
  resolveGeweGroupReplyMode,
} from "./policy.js";

export interface ResolvedGroupContext {
  groupId: string;
  enabled: boolean;
  access: GeweGroupAccessMode;
  trigger: GeweGroupSimpleTrigger;
  legacyTriggerMode: GeweGroupTriggerMode;
  senderAllowed: boolean;
  commandAuthorized: boolean;
  replyMode: ResolvedGeweGroupReplyMode;
  systemPrompt?: string;
  skillFilter?: string[];
  groupConfig?: GeweGroupConfig;
  wildcardConfig?: GeweGroupConfig;
  matchSource?: "direct" | "wildcard" | "default";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAccess(
  gc: GeweGroupConfig | undefined,
  wc: GeweGroupConfig | undefined,
): GeweGroupAccessMode {
  return gc?.access ?? wc?.access ?? "all";
}

function resolveTrigger(
  gc: GeweGroupConfig | undefined,
  wc: GeweGroupConfig | undefined,
): { trigger: GeweGroupSimpleTrigger; legacyTriggerMode: GeweGroupTriggerMode } {
  const raw = gc?.trigger ?? wc?.trigger;

  if (typeof raw === "string") {
    const legacyTriggerMode: GeweGroupTriggerMode = raw === "any" ? "any_message" : "at";
    return { trigger: raw, legacyTriggerMode };
  }

  // Default: at
  return { trigger: "at", legacyTriggerMode: "at" };
}

function resolveSenderAccess(params: {
  access: GeweGroupAccessMode;
  senderId: string;
  senderName?: string;
  gc: GeweGroupConfig | undefined;
  wc: GeweGroupConfig | undefined;
  storeAllowFrom: string[];
}): boolean {
  const { access, senderId, senderName, gc, wc, storeAllowFrom } = params;

  if (access === "all") return true;

  if (access === "claim") {
    return resolveGeweAllowlistMatch({
      allowFrom: storeAllowFrom,
      senderId,
      senderName,
    }).allowed;
  }

  // access === "allowlist": use group-level allowFrom only
  const merged: Array<string | number> = [
    ...(gc?.allowFrom ?? []),
    ...(wc?.allowFrom ?? []),
  ];

  return resolveGeweAllowlistMatch({
    allowFrom: merged,
    senderId,
    senderName,
  }).allowed;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function resolveGroupContext(params: {
  account: ResolvedGeweAccount;
  groupId: string;
  senderId: string;
  senderName?: string;
  storeAllowFrom: string[];
}): ResolvedGroupContext {
  const { account, groupId, senderId, senderName, storeAllowFrom } = params;

  // 1. Resolve group match (account.config.groups is already merged by accounts.ts)
  const match = resolveGeweGroupMatch({
    groups: account.config.groups,
    groupId,
  });
  const gc = match.groupConfig;
  const wc = match.wildcardConfig;

  // 2. Check enabled (any explicit false disables)
  const enabled = gc?.enabled !== false && wc?.enabled !== false;

  // 3. Resolve access
  const access = resolveAccess(gc, wc);

  // 4. Resolve trigger
  const { trigger, legacyTriggerMode } = resolveTrigger(gc, wc);

  // 5. Resolve sender access
  const senderAllowed = resolveSenderAccess({
    access,
    senderId,
    senderName,
    gc,
    wc,
    storeAllowFrom,
  });

  // 6. Command authorization: same as sender access for now
  const commandAuthorized = senderAllowed;

  // 7. Resolve reply mode
  const replyMode = resolveGeweGroupReplyMode({
    groupConfig: gc,
    wildcardConfig: wc,
    autoQuoteReply: account.config.autoQuoteReply,
  });

  // 8. Resolve systemPrompt and skillFilter from gc/wc
  const systemPrompt = gc?.systemPrompt ?? wc?.systemPrompt;
  const skillFilter = gc?.skills ?? wc?.skills;

  // 9. Determine match source
  let matchSource: "direct" | "wildcard" | "default" | undefined;
  if (gc) {
    matchSource = "direct";
  } else if (wc) {
    matchSource = "wildcard";
  } else {
    matchSource = "default";
  }

  return {
    groupId,
    enabled,
    access,
    trigger,
    legacyTriggerMode,
    senderAllowed,
    commandAuthorized,
    replyMode,
    systemPrompt,
    skillFilter,
    groupConfig: gc,
    wildcardConfig: wc,
    matchSource,
  };
}
