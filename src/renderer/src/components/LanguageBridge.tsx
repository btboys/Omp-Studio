import { useEffect } from "react";
import { useStore } from "../store";
import { installLanguageBridge } from "../lib/i18n";

export function LanguageBridge() {
  const language = useStore((s) => s.config?.language || "en");
  useEffect(() => installLanguageBridge(language), [language]);
  return null;
}
