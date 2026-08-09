import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { OmpConfigEntry, OmpConfigSection, OmpConfigSectionId } from "../lib/types";
import { Refresh, Search } from "./icons";

/**
 * Schema-driven editor for omp's config.yml (the keys curated in
 * src/main/omp-config.ts). Values come from `omp config list --json`; every
 * write goes through `omp config set/reset`, which validates and coerces, so
 * the UI can never corrupt the YAML.
 */

const SECTION_LABEL: Record<OmpConfigSectionId, [string, string]> = {
  appearance: ["外观", "Appearance"],
  context: ["上下文", "Context"],
  files: ["文件与工具", "Files & Tools"],
  interaction: ["交互", "Interaction"],
  model: ["模型", "Model"],
  memory: ["记忆", "Memory"],
  providers: ["提供商", "Providers"],
  advanced: ["高级", "Advanced"],
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

function textFor(entry: OmpConfigEntry): string {
  const v = entry.value;
  if (v === undefined || v === null) return "";
  if (entry.type === "array" || entry.type === "record") return JSON.stringify(v, null, 2);
  return String(v);
}

interface RowProps {
  entry: OmpConfigEntry;
  language: "en" | "zh";
  saving: boolean;
  onCommit: (entry: OmpConfigEntry, value: unknown) => Promise<void>;
  onReset: (entry: OmpConfigEntry) => Promise<void>;
}

function Row({ entry, language, saving, onCommit, onReset }: RowProps) {
  const [text, setText] = useState(() => textFor(entry));
  const [jsonOk, setJsonOk] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // Latest text for blur commits: state updates flush after the input event,
  // so a blur arriving in the same tick would read a stale closure.
  const textRef = useRef(text);
  const setDraft = (t: string) => {
    setText(t);
    textRef.current = t;
  };

  // Reflect committed values (e.g. another row's save or a reset) without
  // clobbering the text while the user is actively typing in this row.
  useEffect(() => {
    if (document.activeElement === inputRef.current || document.activeElement === areaRef.current) return;
    setDraft(textFor(entry));
  }, [entry.value]);

  const commitText = () => {
    const current = textRef.current;
    if (entry.type === "number") {
      const t = current.trim();
      if (t === "") return void onReset(entry);
      const n = Number(t);
      if (Number.isNaN(n)) return;
      return void onCommit(entry, n);
    }
    if (entry.type === "array" || entry.type === "record") {
      const t = current.trim();
      if (t === "") return void onReset(entry);
      try {
        return void onCommit(entry, JSON.parse(t));
      } catch {
        setJsonOk(false);
        return;
      }
    }
    if (current.trim() === "") return void onReset(entry);
    return void onCommit(entry, current);
  };

  let control: React.ReactNode;
  if (entry.type === "boolean") {
    control = <Toggle checked={Boolean(entry.value)} onChange={(v) => void onCommit(entry, v)} />;
  } else if (entry.type === "enum" && entry.options?.length) {
    control = (
      <select
        className="set-select"
        value={String(entry.value ?? "")}
        onChange={(e) => void onCommit(entry, e.target.value)}
      >
        {entry.value === undefined && <option value="">{language === "zh" ? "（未设置）" : "(unset)"}</option>}
        {entry.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (entry.type === "number") {
    control = (
      <input
        ref={inputRef}
        className="set-input"
        type="number"
        value={text}
        placeholder={language === "zh" ? "（未设置）" : "(unset)"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  } else if (entry.type === "array" || entry.type === "record") {
    control = (
      <div className="set-json-wrap">
        <textarea
          ref={areaRef}
          className={`set-json ${jsonOk ? "" : "err"}`}
          spellCheck={false}
          value={text}
          placeholder={entry.type === "array" ? '["a", "b"]' : '{"key": "value"}'}
          onChange={(e) => {
            setDraft(e.target.value);
            setJsonOk(true);
          }}
          onBlur={commitText}
        />
        {!jsonOk && <div className="set-json-err">JSON 语法错误</div>}
      </div>
    );
  } else {
    // string, or enum without parseable options
    control = (
      <input
        ref={inputRef}
        className="set-input"
        type="text"
        value={text}
        placeholder={language === "zh" ? "（未设置）" : "(unset)"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }

  return (
    <div className="set-row">
      <label className="set-label set-omp-label" title={entry.key}>
        {entry.key}
      </label>
      <div className="set-control">
        <div className="set-omp-ctrl">
          {control}
          <button
            type="button"
            className="set-omp-reset"
            title={language === "zh" ? "恢复默认" : "Reset to default"}
            onClick={() => void onReset(entry)}
          >
            {saving ? <span className="spinner" /> : <Refresh size={12} />}
          </button>
        </div>
        {entry.description && <div className="set-hint">{entry.description}</div>}
      </div>
    </div>
  );
}

export function OmpConfigPanel() {
  const language = useStore((s) => s.config?.language || "en");
  const pushToast = useStore((s) => s.pushToast);
  const [sections, setSections] = useState<OmpConfigSection[] | null>(null);
  const [query, setQuery] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setError(null);
      const s = await window.pi.settings.getOmpConfig();
      setSections(s as OmpConfigSection[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err: unknown) {
      pushToast("error", (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, ""));
    }
  };

  const commit = async (entry: OmpConfigEntry, value: unknown) => {
    setSavingKey(entry.key);
    await run(() => window.pi.settings.setOmpConfigKey(entry.key, value, entry.type));
    setSavingKey(null);
    void reload();
  };

  const reset = async (entry: OmpConfigEntry) => {
    setSavingKey(entry.key);
    await run(() => window.pi.settings.resetOmpConfigKey(entry.key));
    setSavingKey(null);
    void reload();
  };

  const q = query.trim().toLowerCase();
  const filtered = (sections || [])
    .map((sec) => ({
      ...sec,
      entries: q
        ? sec.entries.filter((e) => e.key.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
        : sec.entries,
    }))
    .filter((sec) => sec.entries.length > 0);

  return (
    <div className="set-card">
      <div className="set-card-title">omp 配置（config.yml）</div>
      <div className="set-omp-toolbar">
        <span className="set-omp-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={language === "zh" ? "搜索配置项…" : "Search settings…"}
          />
        </span>
        <button className="set-btn ghost" onClick={() => void reload()} title="重新读取 config.yml">
          <Refresh size={14} /> {language === "zh" ? "重新加载" : "Reload"}
        </button>
      </div>
      <div className="set-hint">
        {language === "zh"
          ? "写入 ~/.omp/agent/config.yml。改动对新会话立即生效；部分选项需重启会话。标红的值已由 omp 校验。"
          : "Writes ~/.omp/agent/config.yml. Changes apply to new sessions; some options need a restart. Values are validated by omp."}
      </div>
      {error && <div className="set-json-err">加载失败：{error}</div>}
      {!sections && !error && (
        <div className="set-hint">
          <span className="spinner" /> {language === "zh" ? "加载中…" : "Loading…"}
        </div>
      )}
      {filtered.map((sec) => {
        const [zh, en] = SECTION_LABEL[sec.id];
        return (
          <div key={sec.id} className="set-omp-group">
            <div className="set-omp-group-title">
              {language === "zh" ? zh : en}
              <span className="set-omp-count">{sec.entries.length}</span>
            </div>
            {sec.entries.map((e) => (
              <Row key={e.key} entry={e} language={language} saving={savingKey === e.key} onCommit={commit} onReset={reset} />
            ))}
          </div>
        );
      })}
      {filtered.length === 0 && sections && (
        <div className="set-hint">{language === "zh" ? "没有匹配的配置项。" : "No matching settings."}</div>
      )}
    </div>
  );
}
