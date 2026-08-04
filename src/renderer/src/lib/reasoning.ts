import type { Language } from "./i18n";

const LABELS: Record<Language, Record<string, string>> = {
  en: {
    off: "off",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  zh: {
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
  },
};

export function reasoningLevelLabel(level: string | undefined, language: Language): string {
  const value = level || "off";
  return LABELS[language][value] || value;
}
