import { useMemo, useState } from "react";
import { useStore } from "../store";
import {
  draftErrors,
  initialDraft,
  parseHtmlForm,
  safeImageSrc,
  spansText,
  submittedFormData,
  type FormDraft,
  type FormField,
  type FormSpan,
  type HtmlForm,
} from "../lib/html-form";
import { Close } from "./icons";

/**
 * omp 19 ask / `ui.formDialog` arrives as one `form` request whose `html` is
 * model-authored. Render native controls and submit `{ data }` — never the HTML.
 * omp owns the timeout and sends `cancel` when it submits defaults itself.
 */
export function ExtUiFormCard({ threadId }: { threadId: string }) {
  const item = useStore((s) => s.extuiQueue.find((queued) => queued.threadId === threadId && queued.request.method === "form"));
  const respond = useStore((s) => s.respondExtUi);
  const language = useStore((s) => s.config?.language || "en");
  const request = item?.request;
  const form = useMemo(() => (request ? parseHtmlForm(String(request.html || "")) : null), [request]);

  if (!request || !form) return null;
  return <FormDialog key={request.id} threadId={threadId} requestId={request.id} form={form} language={language} respond={respond} />;
}

function FormDialog({
  threadId,
  requestId,
  form,
  language,
  respond,
}: {
  threadId: string;
  requestId: string;
  form: HtmlForm;
  language: string;
  respond: (threadId: string, id: string, payload: Record<string, unknown>) => void;
}) {
  const zh = language === "zh";
  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(form));
  const [showErrors, setShowErrors] = useState(false);
  const errors = draftErrors(form, draft);
  const title = formTitle(form) || (zh ? "请回答" : "Please answer");
  const named = form.fields.some((field) => field.name);

  const cancel = () => respond(threadId, requestId, { cancelled: true });
  const submit = () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    respond(threadId, requestId, { data: submittedFormData(form, draft) });
  };

  return (
    <div className="extui-card form-card" role="dialog" aria-labelledby={`extui-form-${requestId}`}>
      <div className="extui-card-head">
        <div className="extui-card-heading">
          <div>
            <div className="extui-card-kicker">{zh ? "需要回答" : "Question"}</div>
            <div className="extui-card-title" id={`extui-form-${requestId}`}>
              {title}
            </div>
          </div>
        </div>
        <button className="extui-card-close" onClick={cancel} title={zh ? "取消" : "Cancel"}>
          <Close size={16} />
        </button>
      </div>

      {!named ? (
        <div className="extui-card-message">{zh ? "这个表单没有可填写的字段。" : "This form has no fields to fill in."}</div>
      ) : (
        <div className="extui-form">
          {form.sections.map((section, sectionIndex) => (
            <section key={sectionIndex} className="extui-form-section">
              {section.title.length > 0 && spansText(section.title) !== title ? <h3 className="extui-form-legend">{spansText(section.title)}</h3> : null}
              {section.blocks.map((block, blockIndex) => {
                if (block.kind === "field") {
                  const index = form.fields.indexOf(block.field);
                  return (
                    <FieldControl
                      key={blockIndex}
                      field={block.field}
                      index={index}
                      draft={draft}
                      error={showErrors ? errors[index] : undefined}
                      zh={zh}
                      onChange={setDraft}
                    />
                  );
                }
                if (block.kind === "text") {
                  if (sectionIndex === 0 && block.heading && spansText(block.spans) === title) return null;
                  return (
                    <p key={blockIndex} className={block.heading ? "extui-form-heading" : "extui-form-text"}>
                      <Spans spans={block.spans} />
                    </p>
                  );
                }
                if (block.kind === "list") {
                  const ListTag = block.ordered ? "ol" : "ul";
                  return (
                    <ListTag key={blockIndex} className="extui-form-list">
                      {block.items.map((item, itemIndex) => (
                        <li key={itemIndex}>
                          <Spans spans={item} />
                        </li>
                      ))}
                    </ListTag>
                  );
                }
                if (block.kind === "pre") {
                  return (
                    <pre key={blockIndex} className="extui-form-pre">
                      {block.text}
                    </pre>
                  );
                }
                const src = safeImageSrc(block.src);
                return src ? (
                  <img key={blockIndex} className="extui-form-image" src={src} alt={block.alt} />
                ) : block.alt ? (
                  <p key={blockIndex} className="extui-form-text">
                    {block.alt}
                  </p>
                ) : null;
              })}
            </section>
          ))}
        </div>
      )}

      {showErrors && Object.keys(errors).length > 0 ? (
        <div className="extui-form-error">{zh ? "还有必填项没完成。" : "Complete the highlighted fields."}</div>
      ) : null}

      <div className="extui-card-nav">
        <button className="btn" onClick={cancel}>
          {zh ? "取消" : "Cancel"}
        </button>
        <button className="btn primary" onClick={submit} disabled={!named}>
          {zh ? "提交" : "Submit"}
        </button>
      </div>
    </div>
  );
}

function formTitle(form: HtmlForm): string {
  const titled = form.sections.find((section) => section.title.length > 0);
  if (titled) return spansText(titled.title);
  for (const section of form.sections) {
    for (const block of section.blocks) {
      if (block.kind === "text" && block.heading) return spansText(block.spans);
    }
  }
  return "";
}

function Spans({ spans }: { spans: FormSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const text = span.text;
        if (span.style === "code") return <code key={index}>{text}</code>;
        if (span.style === "strong") return <strong key={index}>{text}</strong>;
        if (span.style === "em") return <em key={index}>{text}</em>;
        return <span key={index}>{text}</span>;
      })}
    </>
  );
}

function FieldControl({
  field,
  index,
  draft,
  error,
  zh,
  onChange,
}: {
  field: FormField;
  index: number;
  draft: FormDraft;
  error?: string;
  zh: boolean;
  onChange: (draft: FormDraft) => void;
}) {
  const label = spansText(field.label);
  const hint = error ? translateError(error, zh) : undefined;
  if (field.kind === "choice" && field.select) {
    const selected = new Set(draft.checked[index] ?? []);
    return (
      <label className={`extui-form-field ${error ? "invalid" : ""}`}>
        {label ? <span className="extui-form-label">{label}{field.required ? " *" : ""}</span> : null}
        <select
          multiple={field.multi}
          value={field.multi ? [...selected].map(String) : String(draft.checked[index]?.[0] ?? "")}
          onChange={(event) => {
            const next = [...event.target.selectedOptions].map((option) => Number(option.value)).filter((option) => Number.isInteger(option));
            onChange({ ...draft, checked: draft.checked.map((checked, i) => (i === index ? next : checked)) });
          }}
        >
          {field.options.map((option, optionIndex) => (
            <option key={optionIndex} value={optionIndex} disabled={option.disabled}>
              {spansText(option.label) || option.value}
            </option>
          ))}
        </select>
        {hint ? <span className="extui-form-hint">{hint}</span> : null}
      </label>
    );
  }
  if (field.kind === "choice") {
    const checked = new Set(draft.checked[index] ?? []);
    const toggle = (optionIndex: number) => {
      const next = new Set(checked);
      if (field.multi) {
        if (next.has(optionIndex)) next.delete(optionIndex);
        else next.add(optionIndex);
      } else {
        next.clear();
        next.add(optionIndex);
        onChange({ ...draft, other: draft.other.map((text, i) => (i === index ? "" : text)), checked: draft.checked.map((current, i) => (i === index ? [...next] : current)) });
        return;
      }
      onChange({ ...draft, checked: draft.checked.map((current, i) => (i === index ? [...next] : current)) });
    };
    return (
      <fieldset className={`extui-form-field ${error ? "invalid" : ""}`}>
        {label ? <legend className="extui-form-label">{label}{field.required ? " *" : ""}</legend> : null}
        <div className="extui-form-choices">
          {field.options.map((option, optionIndex) => (
            <label key={optionIndex} className={checked.has(optionIndex) ? "selected" : ""}>
              <input
                type={field.multi ? "checkbox" : "radio"}
                name={`${field.name}-${index}`}
                checked={checked.has(optionIndex)}
                disabled={option.disabled}
                onChange={() => toggle(optionIndex)}
              />
              <span>{spansText(option.label) || option.value}</span>
            </label>
          ))}
        </div>
        {field.other ? (
          <input
            className="extui-form-other"
            type="text"
            value={draft.other[index] ?? ""}
            placeholder={zh ? "其他" : "Other"}
            onChange={(event) => {
              const text = event.target.value;
              onChange({
                ...draft,
                other: draft.other.map((current, i) => (i === index ? text : current)),
                checked: text.trim() && !field.multi ? draft.checked.map((current, i) => (i === index ? [] : current)) : draft.checked,
              });
            }}
          />
        ) : null}
        {hint ? <span className="extui-form-hint">{hint}</span> : null}
      </fieldset>
    );
  }

  const inputType = field.type === "email" || field.type === "url" || field.type === "number" ? field.type : "text";
  return (
    <label className={`extui-form-field ${error ? "invalid" : ""}`}>
      {label ? <span className="extui-form-label">{label}{field.required ? " *" : ""}</span> : null}
      {field.multiline ? (
        <textarea
          rows={Math.min(Math.max(field.rows, 2), 12)}
          value={draft.text[index] ?? ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange({ ...draft, text: draft.text.map((current, i) => (i === index ? event.target.value : current)) })}
        />
      ) : (
        <input
          type={inputType}
          value={draft.text[index] ?? ""}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          onChange={(event) => onChange({ ...draft, text: draft.text.map((current, i) => (i === index ? event.target.value : current)) })}
        />
      )}
      {hint ? <span className="extui-form-hint">{hint}</span> : null}
    </label>
  );
}

function translateError(error: string, zh: boolean): string {
  if (!zh) return error;
  if (error === "Required") return "必填";
  if (error === "Select at least one") return "至少选一项";
  if (error === "Enter a number") return "请输入数字";
  if (error === "Enter an email address") return "请输入邮箱";
  if (error === "Enter a full URL") return "请输入完整网址";
  if (error.startsWith("Must be at least ")) return `不能小于 ${error.slice("Must be at least ".length)}`;
  if (error.startsWith("Must be at most ")) return `不能大于 ${error.slice("Must be at most ".length)}`;
  if (error.startsWith("Needs at least ")) return `至少 ${error.replace(/\D/g, "")} 个字符`;
  if (error.startsWith("At most ")) return `最多 ${error.replace(/\D/g, "")} 个字符`;
  if (error.startsWith("Must match ")) return `需匹配 ${error.slice("Must match ".length)}`;
  return error;
}
