import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { ContentBlock, ExtUiRequest, ViewMessage } from "../lib/types";
import { Check, Close, Shield } from "./icons";

const OTHER_OPTION = "Other (type your own)";
/** omp's getDoneOptionLabel() uses theme.status.success ("✔") + " Done selecting". */
const DONE_SELECTING_FALLBACK = "✔ Done selecting";
const RECOMMENDED_SUFFIX = " (Recommended)";

type SelectOptionView = {
  /** Exact value returned to omp (may include " (Recommended)"). */
  value: string;
  /** Bare label shown in the card. */
  label: string;
  description?: string;
  recommended: boolean;
};

/** Parse omp ask-tool select titles like "(2 selected) question text (1/3)". */
function parseAskSelectTitle(rawTitle: string): {
  displayTitle: string;
  selectedCount: number;
  questionIndex: number | null;
  questionTotal: number | null;
} {
  let title = rawTitle || "";
  let selectedCount = 0;
  const selectedMatch = title.match(/^\((\d+)\s+selected\)\s*/i);
  if (selectedMatch) {
    selectedCount = Number(selectedMatch[1]) || 0;
    title = title.slice(selectedMatch[0].length);
  }
  let questionIndex: number | null = null;
  let questionTotal: number | null = null;
  const progressMatch = title.match(/\s*\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if (progressMatch) {
    questionIndex = Math.max(1, Number(progressMatch[1]) || 1);
    questionTotal = Math.max(questionIndex, Number(progressMatch[2]) || questionIndex);
    title = title.slice(0, -progressMatch[0].length).trim();
  }
  return { displayTitle: title.trim() || rawTitle, selectedCount, questionIndex, questionTotal };
}

function stripRecommendedSuffix(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

function isDoneSelectingOption(label: string): boolean {
  return /Done selecting/i.test(label);
}

function optionLabelOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { label?: unknown }).label === "string") {
    return (raw as { label: string }).label;
  }
  return String(raw ?? "");
}

function optionDescriptionOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const description = (raw as { description?: unknown }).description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}

function isAskSelect(optionLabels: string[], title: string): boolean {
  if (optionLabels.includes(OTHER_OPTION)) return true;
  if (optionLabels.some(isDoneSelectingOption)) return true;
  if (/\(\d+\s+selected\)/i.test(title)) return true;
  if (/\(\d+\s*\/\s*\d+\)\s*$/.test(title)) return true;
  return false;
}

/** Latest in-flight / recent `ask` tool args from the thread (RPC strips descriptions). */
function latestAskArgs(messages: ViewMessage[] | undefined, streaming: ViewMessage | null | undefined, toolRuns: Record<string, any> | undefined): any | null {
  const msgs = [...(messages || []), ...(streaming ? [streaming] : [])];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    for (let j = (m.blocks || []).length - 1; j >= 0; j--) {
      const b = (m.blocks || [])[j] as ContentBlock;
      if (b.type !== "toolCall" || b.name !== "ask") continue;
      const fromBlock = b.arguments && typeof b.arguments === "object" ? b.arguments : null;
      const fromRun = toolRuns?.[b.id]?.args;
      return (fromRun && typeof fromRun === "object" ? fromRun : null) || fromBlock;
    }
  }
  if (toolRuns) {
    const runs = Object.values(toolRuns).filter((r) => r?.name === "ask");
    const last = runs[runs.length - 1];
    if (last?.args && typeof last.args === "object") return last.args;
  }
  return null;
}

/** Build label→description / multi maps from ask tool args. */
function askMetaFromArgs(args: any | null): {
  descriptions: Map<string, string>;
  multiByQuestion: Map<string, boolean>;
  multiByIndex: Map<number, boolean>;
} {
  const descriptions = new Map<string, string>();
  const multiByQuestion = new Map<string, boolean>();
  const multiByIndex = new Map<number, boolean>();
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  questions.forEach((q: any, index: number) => {
    const questionText = typeof q?.question === "string" ? q.question.trim() : "";
    if (questionText) multiByQuestion.set(questionText, !!q?.multi);
    multiByIndex.set(index + 1, !!q?.multi);
    const opts = Array.isArray(q?.options) ? q.options : [];
    for (const opt of opts) {
      const label = optionLabelOf(opt);
      const description = optionDescriptionOf(opt);
      if (label && description) descriptions.set(stripRecommendedSuffix(label), description);
    }
  });
  return { descriptions, multiByQuestion, multiByIndex };
}

export function ExtUiPromptCard({ threadId }: { threadId: string }) {
  const item = useStore((s) =>
    s.extuiQueue.find(
      (queued) => queued.threadId === threadId && (queued.request.method === "confirm" || queued.request.method === "select"),
    ),
  );
  const respond = useStore((s) => s.respondExtUi);
  const setPermission = useStore((s) => s.setPermission);
  const permission = useStore((s) => s.threads[threadId]?.permission);
  const language = useStore((s) => s.config?.language || "en");
  const threadMessages = useStore((s) => s.threads[threadId]?.messages);
  const streaming = useStore((s) => s.threads[threadId]?.streaming || null);
  const toolRuns = useStore((s) => s.threads[threadId]?.toolRuns);
  const request = item?.request;

  // Local multi-select mirror. omp re-prompts after every toggle; respondExtUi
  // removes the current request from the queue before the next one arrives, so
  // we must NOT wipe selection on that brief null gap or checkboxes never stick.
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [answerLog, setAnswerLog] = useState<Record<number, { title: string; selected: string[] }>>({});
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [stickyRequest, setStickyRequest] = useState<ExtUiRequest | null>(null);
  const [awaitingReprompt, setAwaitingReprompt] = useState(false);
  const questionKeyRef = useRef<string>("");

  // Keep showing the last select/confirm card while omp re-arms the next prompt.
  useEffect(() => {
    if (request) {
      setStickyRequest(request);
      return;
    }
    if (!awaitingReprompt) setStickyRequest(null);
  }, [request, awaitingReprompt]);

  const activeRequest = request || (awaitingReprompt ? stickyRequest : null);

  const titleParts = String(activeRequest?.title || "omp extension").split(/\r?\n/);
  const rawTitle = titleParts.shift() || "omp extension";
  const detail = [...titleParts, activeRequest?.message || ""].filter(Boolean).join("\n");
  const askTitle = useMemo(() => parseAskSelectTitle(rawTitle), [rawTitle]);
  const askArgs = useMemo(() => latestAskArgs(threadMessages, streaming, toolRuns), [threadMessages, streaming, toolRuns]);
  const askArgMeta = useMemo(() => askMetaFromArgs(askArgs), [askArgs]);

  const selectOptions = useMemo<SelectOptionView[]>(() => {
    const rawOptions = Array.isArray(activeRequest?.options) ? activeRequest!.options : [];
    return rawOptions.map((raw) => {
      const value = optionLabelOf(raw);
      const label = stripRecommendedSuffix(value);
      const description = optionDescriptionOf(raw) || askArgMeta.descriptions.get(label);
      return {
        value,
        label,
        description,
        recommended: value.endsWith(RECOMMENDED_SUFFIX),
      };
    });
  }, [activeRequest?.options, askArgMeta.descriptions]);

  const optionLabels = useMemo(() => selectOptions.map((o) => o.value), [selectOptions]);
  const askMode = activeRequest?.method === "select" && isAskSelect(optionLabels, rawTitle);
  const doneOption = optionLabels.find(isDoneSelectingOption) || DONE_SELECTING_FALLBACK;
  const choiceOptions = selectOptions.filter((opt) => !isDoneSelectingOption(opt.value) && opt.value !== OTHER_OPTION);

  const multiFromAskArgs =
    (askTitle.questionIndex != null && askArgMeta.multiByIndex.get(askTitle.questionIndex) === true) ||
    askArgMeta.multiByQuestion.get(askTitle.displayTitle) === true;

  // Definite multi-select signals. Prefer ask tool args (RPC omits Done selecting
  // on multi-question allowForward), then title / option heuristics.
  const multiSelect =
    askMode &&
    (multiFromAskArgs ||
      askTitle.selectedCount > 0 ||
      optionLabels.some(isDoneSelectingOption) ||
      multiSelected.length > 0 ||
      awaitingReprompt);

  useEffect(() => {
    // respondExtUi dequeues the current prompt before omp sends the next one.
    // Keep local multi-select state across that gap.
    if (!activeRequest || activeRequest.method !== "select" || !askMode) {
      if (awaitingReprompt) return;
      setMultiSelected([]);
      setAnswerLog({});
      setReviewIndex(null);
      setCustomOpen(false);
      setCustomDraft("");
      questionKeyRef.current = "";
      return;
    }

    const questionKey = `${askTitle.questionIndex ?? 0}:${askTitle.displayTitle}`;
    const questionChanged = questionKeyRef.current !== "" && questionKeyRef.current !== questionKey;
    questionKeyRef.current = questionKey;
    if (questionChanged) {
      setMultiSelected([]);
      setReviewIndex(null);
      setCustomOpen(false);
      setCustomDraft("");
      setAwaitingReprompt(false);
    }

    // Fresh prompt for this question arrived — stop sticky gap handling.
    if (request) setAwaitingReprompt(false);
  }, [activeRequest?.id, request?.id, askMode, askTitle.displayTitle, askTitle.questionIndex, awaitingReprompt]);

  useEffect(() => {
    if (!request?.timeout) return;
    // Keep the card open while the user is mid multi-select; omp re-arms its
    // own timeout on every toggle response.
    if (askMode && multiSelect && (multiSelected.length > 0 || awaitingReprompt)) return;
    const timer = setTimeout(
      () => respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true, timedOut: true }),
      request.timeout,
    );
    return () => clearTimeout(timer);
  }, [request?.id, request?.method, request?.timeout, respond, threadId, askMode, multiSelect, multiSelected.length, awaitingReprompt]);

  if (!activeRequest) return null;

  // While sticky across the respond→reprompt gap, keep UI visible but ignore
  // extra clicks until the live request returns.
  const interactionLocked = !request;

  const cancel = () => {
    if (!request) return;
    setAwaitingReprompt(false);
    setStickyRequest(null);
    respond(threadId, request.id, request.method === "confirm" ? { confirmed: false } : { cancelled: true });
  };
  const autoApprove = () => {
    if (!request) return;
    setPermission(threadId, "auto");
    if (request.method === "confirm") {
      respond(threadId, request.id, { confirmed: true });
    } else {
      const first = selectOptions[0]?.value;
      respond(threadId, request.id, first ? { value: first } : { cancelled: true });
    }
  };

  const isSandbox = /sandbox/i.test(rawTitle);
  const currentQuestion = askTitle.questionIndex ?? 1;
  const totalQuestions = askTitle.questionTotal ?? 1;
  const viewingIndex = reviewIndex ?? currentQuestion;
  const isReviewing = reviewIndex !== null && reviewIndex !== currentQuestion;
  const canAdvance = multiSelected.length > 0 && !interactionLocked;
  const isLastQuestion = totalQuestions <= 1 || currentQuestion >= totalQuestions;
  const nextLabel = language === "zh" ? (isLastQuestion ? "提交" : "下一题") : isLastQuestion ? "Submit" : "Next";

  const respondLive = (payload: Record<string, unknown>, awaitNext: boolean) => {
    if (!request) return;
    setAwaitingReprompt(awaitNext);
    respond(threadId, request.id, payload);
  };

  const toggleMulti = (option: string) => {
    if (isReviewing || interactionLocked) return;
    const bare = stripRecommendedSuffix(option);
    setMultiSelected((prev) => (prev.includes(bare) ? prev.filter((x) => x !== bare) : [...prev, bare]));
    // omp multi-loop toggles on each returned value and re-prompts.
    respondLive({ value: option }, true);
  };

  const chooseSingle = (option: string) => {
    if (isReviewing || interactionLocked) return;
    // Single-select finishes the prompt; multi may re-prompt with "(1 selected)".
    respondLive({ value: option }, multiFromAskArgs || multiSelect);
  };

  const advanceMulti = () => {
    if (isReviewing || !canAdvance) return;
    setAnswerLog((prev) => ({
      ...prev,
      [currentQuestion]: { title: askTitle.displayTitle, selected: [...multiSelected] },
    }));
    // "Done selecting" breaks omp's multi loop even when omitted from options
    // (multi-question allowForward path), then the ask loop advances.
    respondLive({ value: doneOption }, !isLastQuestion);
    if (!isLastQuestion) setMultiSelected([]);
  };

  const openOther = () => {
    if (isReviewing || interactionLocked) return;
    setCustomOpen(true);
  };

  const submitOther = () => {
    const text = customDraft.trim();
    if (!text || interactionLocked) return;
    // omp always follows OTHER with ui.editor(). Stash the already-typed answer
    // so handleExtUi can auto-respond to that editor and skip the second dialog.
    // Use pendingAskCustomInput — NOT pendingEditorText (Composer injects that).
    useStore.setState((s) => {
      const t = s.threads[threadId];
      if (!t) return s;
      return { threads: { ...s.threads, [threadId]: { ...t, pendingAskCustomInput: text } } };
    });
    setAnswerLog((prev) => ({
      ...prev,
      [currentQuestion]: {
        title: askTitle.displayTitle,
        selected: [...multiSelected, language === "zh" ? `其他：${text}` : `Other: ${text}`],
      },
    }));
    setCustomOpen(false);
    setCustomDraft("");
    // Don't sticky-await: editor is answered invisibly; next select remounts the card.
    respondLive({ value: OTHER_OPTION }, false);
  };

  const renderOptionBody = (option: SelectOptionView) => (
    <span className="extui-option-text">
      <span className="extui-option-label">{option.label}</span>
      {option.description ? <span className="extui-option-desc">{option.description}</span> : null}
    </span>
  );

  return (
    <div
      className={`extui-card ${activeRequest.method} ${isSandbox ? "sandbox-card" : ""} ${askMode ? "ask-card" : ""}`}
      role="alertdialog"
      aria-labelledby={`extui-title-${activeRequest.id}`}
    >
      <div className="extui-card-head">
        <div className="extui-card-heading">
          <span className="extui-card-icon" aria-hidden="true">
            <Shield size={15} />
          </span>
          <div>
            <div className="extui-card-kicker">
              {isSandbox
                ? language === "zh"
                  ? "需要授权"
                  : "Approval needed"
                : language === "zh"
                  ? "请选择"
                  : "Choose an option"}
              {askMode && totalQuestions > 1 ? `  (${currentQuestion}/${totalQuestions})` : ""}
              {multiSelect && multiSelected.length > 0
                ? language === "zh"
                  ? ` · 已选 ${multiSelected.length}`
                  : ` · ${multiSelected.length} selected`
                : ""}
            </div>
            <div className="extui-card-title" id={`extui-title-${activeRequest.id}`}>
              {askTitle.displayTitle}
            </div>
          </div>
        </div>
        <button className="extui-card-close" onClick={cancel} title={language === "zh" ? "拒绝并关闭" : "Deny and close"}>
          <Close size={16} />
        </button>
      </div>

      {detail && <div className="extui-card-message">{detail}</div>}

      {askMode && totalQuestions > 1 && (
        <div className="extui-card-progress" role="tablist" aria-label={language === "zh" ? "问题列表" : "Questions"}>
          {Array.from({ length: totalQuestions }, (_, i) => {
            const n = i + 1;
            const active = viewingIndex === n;
            const answered = n < currentQuestion;
            const current = n === currentQuestion;
            return (
              <button
                key={n}
                type="button"
                role="tab"
                aria-selected={active}
                className={`extui-card-progress-chip ${active ? "active" : ""} ${answered ? "answered" : ""} ${current ? "current" : ""}`}
                onClick={() => setReviewIndex(n === currentQuestion ? null : n)}
                title={
                  n > currentQuestion
                    ? language === "zh"
                      ? "请先答完当前题"
                      : "Finish the current question first"
                    : n < currentQuestion
                      ? language === "zh"
                        ? "查看已答题目（不可再改）"
                        : "Review answered question (read-only)"
                      : language === "zh"
                        ? "当前题目"
                        : "Current question"
                }
                disabled={n > currentQuestion}
              >
                {answered ? <Check size={11} /> : null}
                <span>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {activeRequest.method === "confirm" ? (
        <div className="extui-card-actions">
          <button className="btn" onClick={cancel} disabled={interactionLocked}>
            {language === "zh" ? "拒绝" : "Deny"}
          </button>
          <button
            className="btn primary"
            disabled={interactionLocked}
            onClick={() => request && respond(threadId, request.id, { confirmed: true })}
          >
            {language === "zh" ? "仅允许本次" : "Allow once"}
          </button>
        </div>
      ) : isReviewing ? (
        <div className="extui-card-review">
          <div className="extui-card-review-hint">
            {language === "zh"
              ? `第 ${viewingIndex} 题（只读，无法回退修改）`
              : `Question ${viewingIndex} (read-only)`}
          </div>
          {answerLog[viewingIndex] ? (
            <>
              <div className="extui-card-title" style={{ marginTop: 8 }}>
                {answerLog[viewingIndex].title}
              </div>
              <ul className="extui-card-review-answers">
                {answerLog[viewingIndex].selected.map((item) => (
                  <li key={item}>
                    <Check size={11} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="extui-card-review-hint">
              {language === "zh" ? "没有找到该题的本地答题记录。" : "No local answer record for this question."}
            </div>
          )}
          <div className="extui-card-nav">
            <button
              type="button"
              className="btn"
              disabled={viewingIndex <= 1}
              onClick={() => setReviewIndex(Math.max(1, viewingIndex - 1))}
            >
              {language === "zh" ? "上一题" : "Previous"}
            </button>
            <button type="button" className="btn primary" onClick={() => setReviewIndex(null)}>
              {language === "zh" ? "返回当前题" : "Back to current"}
            </button>
          </div>
        </div>
      ) : askMode && multiSelect ? (
        <>
          <div className="extui-card-options multi">
            {choiceOptions.map((option) => {
              const checked = multiSelected.includes(option.label);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`${checked ? "selected" : ""} ${option.recommended ? "recommended" : ""}`}
                  onClick={() => toggleMulti(option.value)}
                  disabled={interactionLocked}
                >
                  <span className={`extui-check ${checked ? "checked" : ""}`} aria-hidden="true">
                    {checked ? <Check size={10} /> : null}
                  </span>
                  {renderOptionBody(option)}
                  {option.recommended && <small>{language === "zh" ? "推荐" : "Recommended"}</small>}
                </button>
              );
            })}
            <button type="button" className="other" onClick={openOther} disabled={interactionLocked}>
              <span className="extui-check" aria-hidden="true" />
              <span className="extui-option-text">
                <span className="extui-option-label">{language === "zh" ? "其他（自己输入）" : OTHER_OPTION}</span>
              </span>
            </button>
          </div>

          {customOpen && (
            <div className="extui-card-custom">
              <input
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                placeholder={language === "zh" ? "输入自定义答案…" : "Type your own answer…"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitOther();
                }}
                autoFocus
              />
              <button type="button" className="btn" onClick={() => setCustomOpen(false)}>
                {language === "zh" ? "取消" : "Cancel"}
              </button>
              <button type="button" className="btn primary" onClick={submitOther} disabled={!customDraft.trim()}>
                {language === "zh" ? "使用该答案" : "Use answer"}
              </button>
            </div>
          )}

          <div className="extui-card-nav">
            <button
              type="button"
              className="btn"
              disabled={currentQuestion <= 1}
              onClick={() => setReviewIndex(Math.max(1, currentQuestion - 1))}
              title={
                language === "zh"
                  ? "查看上一题（只读；无法回退修改）"
                  : "Review previous question (read-only)"
              }
            >
              {language === "zh" ? "上一题" : "Previous"}
            </button>
            <button type="button" className="btn primary" disabled={!canAdvance} onClick={advanceMulti}>
              {nextLabel}
            </button>
          </div>
        </>
      ) : (
        <div className="extui-card-options">
          {selectOptions.map((option, index) => {
            const deny = /^(deny|拒绝)$/i.test(option.label);
            const recommended = option.recommended || (!askMode && index === 0);
            return (
              <button
                key={option.value}
                className={`${recommended ? "recommended" : ""} ${deny ? "deny" : ""}`}
                onClick={() => chooseSingle(option.value)}
              >
                {renderOptionBody(option)}
                {recommended && <small>{language === "zh" ? "推荐" : "Recommended"}</small>}
              </button>
            );
          })}
        </div>
      )}

      {isSandbox && permission !== "auto" && (
        <div className="extui-card-autopilot">
          <button onClick={autoApprove}>{language === "zh" ? "替我审批" : "Approve on my behalf"}</button>
          <span>
            {language === "zh" ? "常规操作自动放行，危险操作仍会确认" : "Routine operations auto-approve; dangerous ones still ask"}
          </span>
        </div>
      )}
    </div>
  );
}
