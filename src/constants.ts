export const CHANNEL_ID = "synodeai" as const;
export const CHANNEL_CONFIG_KEY = "synodeai" as const;
export const CHANNEL_DOCS_PATH = "/channels/synodeai" as const;
export const CHANNEL_DOCS_LABEL = "synodeai" as const;
export const CHANNEL_PREFIX_REGEX = /^(synodeai|gewe|wechat|wx):/i;
export const CHANNEL_ALIASES = ["synodeai", "gewe", "wechat", "wx"] as const;

export function stripChannelPrefix(value: string): string {
  return value.replace(CHANNEL_PREFIX_REGEX, "");
}
