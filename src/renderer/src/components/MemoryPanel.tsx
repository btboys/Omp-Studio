import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { MemoryBank, MemoryRow } from "../lib/types";
import { Check, Edit, Folder, Plus, Refresh, Search, Trash } from "./icons";

/**
 * Memory manager for Mnemopi banks (~/.omp/agent/memories/mnemopi/banks).
 * Each bank is a per-project SQLite DB holding facts (working_memory) and
 * episodes (episodic_memory); the FTS indexes are kept in sync by triggers in
 * the DB, so add/edit/delete here is immediately recallable by the agent.
 */

const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const PAGE_SIZE = 50;

const TYPE_LABEL: Record<string, [string, string]> = {
  fact: ["事实", "Fact"],
  episode: ["片段", "Episode"],
  instruction: ["指令", "Instruction"],
  preference: ["偏好", "Preference"],
};

function typeLabel(type: string, language: "en" | "zh"): string {
  const l = TYPE_LABEL[type];
  return l ? (language === "zh" ? l[0] : l[1]) : type;
}

function fmtTime(iso: string | null | undefined, language: "en" | "zh"): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (!ms) return iso;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 45) return language === "zh" ? "刚刚" : "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return language === "zh" ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return language === "zh" ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return language === "zh" ? `${d} 天前` : `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

interface ImpProps {
  language: "en" | "zh";
  importance: number;
  onImportance: (v: number) => void;
}

function ImportanceField({ language, importance, onImportance }: ImpProps) {
  return (
    <label className="mem-form-row">
      <span className="mem-form-label">{language === "zh" ? "重要度" : "Importance"}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={importance}
        onChange={(e) => onImportance(Number(e.target.value))}
      />
      <span className="mem-form-value">{importance.toFixed(2)}</span>
    </label>
  );
}

export function MemoryPanel() {
  const language = useStore((s) => s.config?.language || "en");
  const pushToast = useStore((s) => s.pushToast);
  const [banks, setBanks] = useState<MemoryBank[] | null>(null);
  const [sqliteOk, setSqliteOk] = useState(true);
  const [bankId, setBankId] = useState("");
  const [table, setTable] = useState<"working" | "episodes">("working");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemoryRow | null>(null);
  const [draft, setDraft] = useState({ content: "", importance: 0.6, type: "fact" });
  const [editDraft, setEditDraft] = useState({ content: "", importance: 0.5 });
  const searchTimer = useRef<number | null>(null);

  const loadRows = useCallback(async () => {
    if (!bankId || !sqliteOk) return;
    setBusy(true);
    try {
      const res = (await window.pi.memory.list(bankId, {
        table,
        q: q.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })) as { ok: boolean; rows?: MemoryRow[]; total?: number; error?: string };
      if (res.ok) {
        setRows(res.rows ?? []);
        setTotal(res.total ?? res.rows?.length ?? 0);
        // A delete on the last page can leave the page index out of range.
        const pages = Math.max(1, Math.ceil((res.total ?? 0) / PAGE_SIZE));
        if (page >= pages && page > 0) setPage(pages - 1);
      } else {
        pushToast("error", res.error || "加载失败");
      }
    } catch (e: unknown) {
      pushToast("error", errOf(e));
    } finally {
      setBusy(false);
    }
  }, [bankId, table, q, page, sqliteOk, pushToast]);

  const reload = useCallback(async () => {
    const b = (await window.pi.memory.listBanks()) as { ok: boolean; banks?: MemoryBank[] };
    if (b.ok && b.banks) setBanks(b.banks);
    await loadRows();
  }, [loadRows]);

  useEffect(() => {
    void (async () => {
      const res = (await window.pi.memory.listBanks()) as {
        ok: boolean;
        banks?: MemoryBank[];
        sqliteAvailable?: boolean;
        error?: string;
      };
      if (!res.ok) {
        pushToast("error", res.error || "加载记忆库失败");
        return;
      }
      setBanks(res.banks ?? []);
      setSqliteOk(res.sqliteAvailable ?? false);
      const first = res.banks?.[0];
      if (first) setBankId((cur) => cur || first.id);
    })();
  }, [pushToast]);

  // Debounced row load: instant on bank/table/page switch, 250ms on typing.
  // Only a bank/table/query change resets to page 0 (a page-only change must
  // fall through to the load, otherwise forward pagination snaps back).
  const filterKey = `${bankId}|${table}|${q}`;
  const lastFilterRef = useRef(filterKey);
  useEffect(() => {
    if (!bankId || !sqliteOk) return;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const keyChanged = lastFilterRef.current !== filterKey;
    lastFilterRef.current = filterKey;
    if (keyChanged && page !== 0) {
      setPage(0);
      return;
    }
    searchTimer.current = window.setTimeout(() => void loadRows(), q.trim() ? 250 : 0);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [bankId, table, q, page, sqliteOk, loadRows]);

  const submitAdd = async () => {
    if (!bankId) return;
    const content = draft.content.trim();
    if (!content) {
      pushToast("warning", language === "zh" ? "内容不能为空" : "Content is empty");
      return;
    }
    setBusy(true);
    try {
      const res = (await window.pi.memory.add(bankId, draft)) as { ok: boolean; error?: string };
      if (res.ok) {
        pushToast("success", language === "zh" ? "记忆已写入" : "Memory added");
        setAdding(false);
        setDraft({ content: "", importance: 0.6, type: "fact" });
        await reload();
      } else {
        pushToast("error", res.error || "添加失败");
      }
    } catch (e: unknown) {
      pushToast("error", errOf(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = async (row: MemoryRow) => {
    if (!bankId) return;
    try {
      const res = (await window.pi.memory.get(bankId, row.table, row.id)) as { ok: boolean; row?: MemoryRow; error?: string };
      if (!res.ok || !res.row) {
        pushToast("error", res.error || "读取记忆失败");
        return;
      }
      setEditing(res.row);
      setEditDraft({ content: res.row.content, importance: res.row.importance });
    } catch (e: unknown) {
      pushToast("error", errOf(e));
    }
  };

  const saveEdit = async () => {
    if (!bankId || !editing) return;
    if (!editDraft.content.trim()) {
      pushToast("warning", language === "zh" ? "内容不能为空" : "Content is empty");
      return;
    }
    setBusy(true);
    try {
      const res = (await window.pi.memory.update(bankId, {
        table: editing.table,
        id: editing.id,
        content: editDraft.content,
        importance: editDraft.importance,
      })) as { ok: boolean; error?: string };
      if (res.ok) {
        pushToast("success", language === "zh" ? "记忆已更新" : "Memory updated");
        setEditing(null);
        await reload();
      } else {
        pushToast("error", res.error || "保存失败");
      }
    } catch (e: unknown) {
      pushToast("error", errOf(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: MemoryRow) => {
    if (!bankId) return;
    const msg = language === "zh" ? "删除这条记忆？此操作不可撤销。" : "Delete this memory? This cannot be undone.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const res = (await window.pi.memory.delete(bankId, row.table, row.id)) as { ok: boolean; error?: string };
      if (res.ok) {
        pushToast("success", language === "zh" ? "记忆已删除" : "Memory deleted");
        await reload();
      } else {
        pushToast("error", res.error || "删除失败");
      }
    } catch (e: unknown) {
      pushToast("error", errOf(e));
    } finally {
      setBusy(false);
    }
  };

  const zh = language === "zh";

  return (
    <div className="set-card mem-panel">
      <div className="mem-toolbar">
        <select
          className="set-select mem-bank"
          value={bankId}
          onChange={(e) => setBankId(e.target.value)}
          disabled={!banks?.length || !sqliteOk}
          title="记忆库（项目）"
        >
          {banks === null ? (
            <option>{zh ? "加载中…" : "Loading…"}</option>
          ) : banks.length === 0 ? (
            <option>{zh ? "没有记忆库" : "No memory banks"}</option>
          ) : (
            banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}（{b.working >= 0 ? `${b.working} / ${b.episodes}` : "?"}）
              </option>
            ))
          )}
        </select>
        <span className="mem-search">
          <Search size={13} />
          <input
            className="set-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={zh ? "搜索记忆…" : "Search memories…"}
            disabled={!bankId || !sqliteOk}
          />
        </span>
        <select className="set-select mem-type" value={table} onChange={(e) => setTable(e.target.value as "working" | "episodes")} disabled={!bankId || !sqliteOk}>
          <option value="working">{zh ? "事实" : "Facts"}</option>
          <option value="episodes">{zh ? "片段" : "Episodes"}</option>
        </select>
        <button className="set-btn ghost" onClick={() => void reload()} title={zh ? "刷新" : "Reload"} disabled={!bankId}>
          <Refresh size={14} /> {zh ? "刷新" : "Reload"}
        </button>
        <button className="set-btn primary" onClick={() => setAdding(true)} disabled={!bankId || !sqliteOk}>
          <Plus size={14} /> {zh ? "新增记忆" : "Add"}
        </button>
        <button className="set-btn ghost" onClick={() => void window.pi.memory.openDir()} title={zh ? "在文件管理器中打开记忆目录" : "Open memory folder"}>
          <Folder size={14} /> {zh ? "目录" : "Folder"}
        </button>
      </div>

      {!sqliteOk && (
        <div className="set-hint mem-warn">
          {zh
            ? "未找到 sqlite3 命令行工具：记忆库列表可用，但搜索与增删改需要安装 sqlite3（macOS/Linux 自带；Windows 请安装并加入 PATH）。"
            : "sqlite3 CLI not found: bank list works, but search/edit needs sqlite3 on PATH."}
        </div>
      )}
      {sqliteOk && (
        <div className="set-hint">
          {zh
            ? "管理 ~/.omp/agent/memories 下的 Mnemopi 记忆库。改动立即生效，可被 agent 召回（写入操作不可撤销）。"
            : "Manage Mnemopi banks under ~/.omp/agent/memories. Changes are recallable by the agent immediately."}
        </div>
      )}

      {adding && (
        <div className="mem-form">
          <div className="mem-form-title">{zh ? "新增记忆" : "Add memory"}</div>
          <textarea
            className="mem-area"
            rows={4}
            autoFocus
            value={draft.content}
            onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
            placeholder={zh ? "记一条事实，例如：项目的构建命令是 npm run build …" : "e.g. The project builds with `npm run build` …"}
          />
          <div className="mem-form-row">
            <span className="mem-form-label">{zh ? "类型" : "Type"}</span>
            <select className="set-select mem-type" value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
              {(["fact", "instruction", "preference"] as const).map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t, language)}
                </option>
              ))}
            </select>
          </div>
          <ImportanceField language={language} importance={draft.importance} onImportance={(v) => setDraft((d) => ({ ...d, importance: v }))} />
          <div className="mem-form-actions">
            <button className="set-btn primary" onClick={() => void submitAdd()} disabled={busy}>
              <Check size={14} /> {zh ? "保存" : "Save"}
            </button>
            <button className="set-btn ghost" onClick={() => setAdding(false)} disabled={busy}>
              {zh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      <div className="mem-list">
        {rows === null ? (
          <div className="set-hint mem-empty">
            <span className="spinner" /> {zh ? "加载中…" : "Loading…"}
          </div>
        ) : rows.length === 0 ? (
          <div className="set-hint mem-empty">{zh ? "没有匹配的记忆。" : "No matching memories."}</div>
        ) : (
          rows.map((row) =>
            editing && editing.id === row.id && editing.table === row.table ? (
              <div className="mem-item mem-item-edit" key={row.table + row.id}>
                <div className="mem-item-head">
                  <span className={`mem-badge ${row.table}`}>{row.table === "episodes" ? (zh ? "片段" : "Episode") : (zh ? "事实" : "Fact")}</span>
                  <span className="mem-item-meta">
                    {typeLabel(row.memoryType, language)}
                    {row.timestamp ? ` · ${fmtTime(row.timestamp, language)}` : ""}
                  </span>
                </div>
                <textarea className="mem-area" rows={6} value={editDraft.content} onChange={(e) => setEditDraft((d) => ({ ...d, content: e.target.value }))} autoFocus />
                <ImportanceField language={language} importance={editDraft.importance} onImportance={(v) => setEditDraft((d) => ({ ...d, importance: v }))} />
                <div className="mem-item-actions">
                  <button className="set-btn primary" onClick={() => void saveEdit()} disabled={busy}>
                    <Check size={14} /> {zh ? "保存" : "Save"}
                  </button>
                  <button className="set-btn ghost" onClick={() => setEditing(null)} disabled={busy}>
                    {zh ? "取消" : "Cancel"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mem-item" key={row.table + row.id}>
                <div className="mem-item-head">
                  <span className={`mem-badge ${row.table}`}>{row.table === "episodes" ? (zh ? "片段" : "Episode") : (zh ? "事实" : "Fact")}</span>
                  <span className="mem-item-meta">
                    {typeLabel(row.memoryType, language)}
                    {row.timestamp ? ` · ${fmtTime(row.timestamp, language)}` : ""}
                  </span>
                  <span className="mem-item-imp" title={zh ? `重要度 ${row.importance.toFixed(2)}` : `Importance ${row.importance.toFixed(2)}`}>
                    <span className="mem-imp-track">
                      <span className="mem-imp-fill" style={{ width: `${Math.round(row.importance * 100)}%` }} />
                    </span>
                  </span>
                  <span className="mem-item-actions">
                    <button className="set-iconbtn" title={zh ? "编辑" : "Edit"} onClick={() => void startEdit(row)} disabled={busy}>
                      <Edit size={13} />
                    </button>
                    <button className="set-iconbtn danger" title={zh ? "删除" : "Delete"} onClick={() => void remove(row)} disabled={busy}>
                      <Trash size={13} />
                    </button>
                  </span>
                </div>
                <div className="mem-item-content">{row.content}</div>
              </div>
            ),
          )
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="mem-pager">
          <button className="set-btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
            ‹ {zh ? "上一页" : "Prev"}
          </button>
          <span className="mem-pager-info">
            {zh ? `第 ${page + 1} / ${Math.ceil(total / PAGE_SIZE)} 页` : `Page ${page + 1} / ${Math.ceil(total / PAGE_SIZE)}`}
            <span className="mem-pager-total">（{zh ? `共 ${total} 条` : `${total} total`}）</span>
          </span>
          <button
            className="set-btn ghost"
            disabled={page >= Math.ceil(total / PAGE_SIZE) - 1}
            onClick={() => setPage(page + 1)}
          >
            {zh ? "下一页" : "Next"} ›
          </button>
        </div>
      )}
    </div>
  );
}
