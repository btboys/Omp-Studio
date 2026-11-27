/**
 * Parse omp 19 `extension_ui_request` method `form` HTML into native controls
 * and build the `{ data }` object `parseFormDialogResponse` accepts.
 *
 * Field extraction follows oh-my-pi `html-form/parse.ts` + `data.ts` (v19.2.1):
 * a mismatch throws on the omp side instead of being coerced. Model HTML is
 * never injected into the renderer; only this structured result is drawn.
 */

export type FormSpanStyle = "code" | "strong" | "em";

export interface FormSpan {
  text: string;
  style?: FormSpanStyle;
}

export interface ChoiceOption {
  value: string;
  label: FormSpan[];
  checked: boolean;
  disabled: boolean;
}

export interface ChoiceField {
  kind: "choice";
  name: string;
  multi: boolean;
  select: boolean;
  other: boolean;
  label: FormSpan[];
  options: ChoiceOption[];
  required: boolean;
}

export interface TextField {
  kind: "text";
  name: string;
  type: string;
  multiline: boolean;
  label: FormSpan[];
  value: string;
  placeholder: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows: number;
}

export type FormField = ChoiceField | TextField;

export type FormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "field"; field: FormField };

export interface FormSection {
  title: FormSpan[];
  blocks: FormBlock[];
  fieldset: boolean;
}

export interface HtmlForm {
  sections: FormSection[];
  fields: FormField[];
  hidden: [string, string][];
}

export type HtmlFormValue = string | number | string[];

/** Per-field UI state, indexed like `HtmlForm.fields`. */
export interface FormDraft {
  checked: number[][];
  other: string[];
  text: string[];
}

export interface HtmlNode {
  type: "element" | "text" | "comment";
  tag: string;
  text: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

const SKIPPED: Record<string, true> = {
  button: true,
  head: true,
  iframe: true,
  link: true,
  meta: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  title: true,
};

const BLOCK: Record<string, true> = {
  address: true,
  article: true,
  aside: true,
  blockquote: true,
  dd: true,
  details: true,
  div: true,
  dl: true,
  dt: true,
  figure: true,
  figcaption: true,
  footer: true,
  header: true,
  li: true,
  main: true,
  nav: true,
  p: true,
  section: true,
};

const HEADING: Record<string, true> = { h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, summary: true };

const STYLE_OF: Record<string, FormSpanStyle> = {
  b: "strong",
  code: "code",
  em: "em",
  i: "em",
  kbd: "code",
  samp: "code",
  strong: "strong",
  tt: "code",
};

const IGNORED_INPUTS: Record<string, true> = { button: true, file: true, image: true, reset: true, submit: true };

const CONTROL: Record<string, true> = { input: true, select: true, textarea: true };

export function spansText(spans: readonly FormSpan[]): string {
  return spans.map((span) => span.text).join("");
}

export function isArrayChoice(field: ChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

/** Same rules as omp `choiceValue`: Other text replaces a radio, or joins a checkbox group. */
export function choiceValue(field: ChoiceField, checked: ReadonlySet<number>, other?: string): HtmlFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) => (checked.has(index) && !option.disabled ? [option.value] : []));
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

export function textValue(field: TextField, text: string): HtmlFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

export function fieldError(field: FormField, value: HtmlFormValue | undefined): string | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return isArrayChoice(field) ? "Select at least one" : "Required";
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? "Required" : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return "Enter a number";
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`;
  if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (field.type === "url") {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "Enter a full URL";
    } catch {
      return "Enter a full URL";
    }
  }
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
    return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
  }
  return undefined;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
}

export function initialDraft(form: HtmlForm): FormDraft {
  return {
    checked: form.fields.map((field) =>
      field.kind === "choice" ? field.options.flatMap((option, index) => (option.checked ? [index] : [])) : [],
    ),
    other: form.fields.map(() => ""),
    text: form.fields.map((field) => (field.kind === "text" ? field.value : "")),
  };
}

function draftValue(form: HtmlForm, draft: FormDraft, index: number): HtmlFormValue | undefined {
  const field = form.fields[index];
  if (!field) return undefined;
  return field.kind === "choice"
    ? choiceValue(field, new Set(draft.checked[index] ?? []), draft.other[index])
    : textValue(field, draft.text[index] ?? "");
}

/**
 * Data omp accepts for this form. Hidden inputs are echoed; the last field of a
 * shared name that can carry the entry wins, matching `parseFormDialogResponse`.
 */
export function submittedFormData(form: HtmlForm, draft: FormDraft): Record<string, HtmlFormValue> {
  const data: Record<string, HtmlFormValue> = Object.create(null);
  for (const [name, value] of form.hidden) data[name] = value;
  const byName = new Map<string, number[]>();
  form.fields.forEach((field, index) => {
    if (!field.name) return;
    const list = byName.get(field.name) ?? [];
    list.push(index);
    byName.set(field.name, list);
  });
  for (const [name, indexes] of byName) {
    let carried: HtmlFormValue | undefined;
    let any = false;
    for (const index of indexes) {
      const field = form.fields[index];
      const value = draftValue(form, draft, index);
      if (field?.kind === "text" || value !== undefined) {
        carried = value;
        any = true;
      }
    }
    if (any && carried !== undefined) data[name] = carried;
  }
  return data;
}

export function draftErrors(form: HtmlForm, draft: FormDraft): Record<number, string> {
  const errors: Record<number, string> = {};
  form.fields.forEach((field, index) => {
    if (!field.name) return;
    const error = fieldError(field, draftValue(form, draft, index));
    if (error) errors[index] = error;
  });
  return errors;
}

/** http(s) or a raster data URL. SVG and file URLs stay out of the renderer. */
export function safeImageSrc(src: string): string | null {
  const trimmed = src.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) return trimmed.replace(/\s+/g, "");
  return null;
}

function attr(node: HtmlNode, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
}

function hasAttr(node: HtmlNode, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(node.attrs, name);
}

function numberAttr(node: HtmlNode, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw == null || raw.trim() === "") return undefined;
  const number = Number(raw);
  return Number.isFinite(number) ? number : undefined;
}

function findFirst(node: HtmlNode, pred: (node: HtmlNode) => boolean): HtmlNode | undefined {
  if (pred(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, pred);
    if (found) return found;
  }
  return undefined;
}

function elementChildren(node: HtmlNode): HtmlNode[] {
  return node.children.filter((child) => child.type === "element");
}

function isControl(node: HtmlNode): boolean {
  return node.type === "element" && !!CONTROL[node.tag];
}

function controlsIn(node: HtmlNode): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (current: HtmlNode) => {
    for (const child of current.children) {
      if (isControl(child)) found.push(child);
      if (child.type === "element" && !SKIPPED[child.tag]) visit(child);
    }
  };
  visit(node);
  return found;
}

function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

function normalizeSpans(spans: FormSpan[]): FormSpan[] {
  const out: FormSpan[] = [];
  for (const span of spans) {
    appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
  }
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((span) => span.text !== "");
}

function textContent(node: HtmlNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(textContent).join("");
}

class FormBuilder {
  readonly sections: FormSection[] = [];
  readonly fields: FormField[] = [];
  readonly hidden: [string, string][] = [];
  readonly groups = new Map<string, { field: ChoiceField; section: FormSection; block: Extract<FormBlock, { kind: "field" }> }>();
  readonly labelFor = new Map<string, HtmlNode>();
  section: FormSection = { title: [], blocks: [], fieldset: false };
  inline: FormSpan[] = [];
  fieldsetDepth = 0;

  root: HtmlNode;

  constructor(root: HtmlNode) {
    this.root = root;
    this.sections.push(this.section);
  }

  build(): HtmlForm {
    const ids = new Set<string>();
    for (const control of controlsIn(this.root)) {
      const id = attr(control, "id");
      if (id) ids.add(id);
    }
    const visitLabels = (node: HtmlNode) => {
      if (node.type !== "element" || SKIPPED[node.tag]) return;
      if (node.tag === "label") {
        const target = attr(node, "for");
        if (target && ids.has(target) && !this.labelFor.has(target)) this.labelFor.set(target, node);
      }
      for (const child of node.children) visitLabels(child);
    };
    visitLabels(this.root);
    this.children(this.root);
    this.flush(false);
    for (const field of this.fields) {
      if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
      field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
    }
    return {
      sections: this.sections.filter((section) => section.blocks.length > 0 || section.title.length > 0),
      fields: this.fields,
      hidden: this.hidden,
    };
  }

  children(node: HtmlNode): void {
    for (const child of node.children) this.walk(child);
  }

  walk(node: HtmlNode): void {
    if (node.type === "comment") return;
    if (node.type === "text") {
      appendSpan(this.inline, node.text, undefined);
      return;
    }
    const tag = node.tag;
    if (SKIPPED[tag]) return;
    switch (tag) {
      case "br":
        appendSpan(this.inline, "\n", undefined);
        return;
      case "hr":
        this.flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        this.control(node, undefined);
        return;
      case "label":
        this.label(node);
        return;
      case "fieldset":
        this.fieldset(node);
        return;
      case "legend":
        this.flush(false);
        this.children(node);
        this.flush(true);
        return;
      case "ul":
      case "ol":
        this.list(node, tag === "ol");
        return;
      case "pre":
        this.flush(false);
        this.section.blocks.push({ kind: "pre", text: textContent(node).replace(/^\n/, "").trimEnd() });
        return;
      case "img": {
        const src = attr(node, "src")?.trim();
        if (!src) return;
        this.flush(false);
        this.section.blocks.push({ kind: "image", src, alt: (attr(node, "alt") ?? "").trim() });
        return;
      }
      default:
        break;
    }
    if (HEADING[tag]) {
      this.flush(false);
      this.children(node);
      this.flush(true);
      return;
    }
    if (BLOCK[tag] || tag === "#document" || tag === "html" || tag === "body") {
      this.flush(false);
      this.children(node);
      this.flush(false);
      return;
    }
    // Inline wrappers (span, strong, …) still have to surface nested controls.
    this.children(node);
  }

  flush(heading: boolean): void {
    const spans = normalizeSpans(this.inline);
    this.inline = [];
    if (spans.length > 0) this.section.blocks.push({ kind: "text", spans, heading });
  }

  spansOf(element: HtmlNode): FormSpan[] {
    const spans: FormSpan[] = [];
    const visit = (node: HtmlNode, style: FormSpanStyle | undefined) => {
      if (node.type === "comment") return;
      if (node.type === "text") {
        appendSpan(spans, node.text, style);
        return;
      }
      const tag = node.tag;
      if (SKIPPED[tag] || CONTROL[tag] || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      if (tag === "img") {
        appendSpan(spans, attr(node, "alt") ?? "", style);
        return;
      }
      if (BLOCK[tag] || HEADING[tag]) appendSpan(spans, " ", undefined);
      for (const child of node.children) visit(child, STYLE_OF[tag] ?? style);
    };
    for (const child of element.children) visit(child, undefined);
    return normalizeSpans(spans);
  }

  label(label: HtmlNode): void {
    const target = attr(label, "for");
    if (target && this.labelFor.get(target) === label) return;
    const controls = controlsIn(label);
    if (controls.length === 0) {
      this.children(label);
      return;
    }
    this.flush(false);
    const spans = this.spansOf(label);
    for (const control of controls) this.control(control, spans);
  }

  fieldset(fieldset: HtmlNode): void {
    this.flush(false);
    const legend = elementChildren(fieldset).find((child) => child.tag === "legend");
    if (this.fieldsetDepth > 0) {
      if (legend) this.walk(legend);
    } else {
      this.startSection(legend ? this.spansOf(legend) : [], true);
    }
    this.fieldsetDepth++;
    for (const child of fieldset.children) {
      if (child !== legend) this.walk(child);
    }
    this.flush(false);
    this.fieldsetDepth--;
    if (this.fieldsetDepth === 0) this.startSection([], false);
  }

  startSection(title: FormSpan[], fieldset: boolean): void {
    if (this.section.blocks.length === 0 && this.section.title.length === 0) {
      this.section.title = title;
      this.section.fieldset = fieldset;
      return;
    }
    this.section = { title, blocks: [], fieldset };
    this.sections.push(this.section);
  }

  list(list: HtmlNode, ordered: boolean): void {
    this.flush(false);
    if (controlsIn(list).length > 0) {
      this.children(list);
      this.flush(false);
      return;
    }
    const items = elementChildren(list)
      .filter((child) => child.tag === "li")
      .map((item) => this.spansOf(item))
      .filter((spans) => spans.length > 0);
    if (items.length > 0) this.section.blocks.push({ kind: "list", items, ordered });
  }

  detachedLabel(control: HtmlNode): FormSpan[] {
    const id = attr(control, "id");
    const label = id ? this.labelFor.get(id) : undefined;
    if (label) return this.spansOf(label);
    const text = attr(control, "aria-label") ?? attr(control, "title");
    return text ? normalizeSpans([{ text }]) : [];
  }

  nameLabel(name: string): FormSpan[] {
    return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
  }

  addField(field: FormField): Extract<FormBlock, { kind: "field" }> {
    const block: Extract<FormBlock, { kind: "field" }> = { kind: "field", field };
    this.fields.push(field);
    this.section.blocks.push(block);
    return block;
  }

  control(control: HtmlNode, wrapping: FormSpan[] | undefined): void {
    this.flush(false);
    const label = wrapping && wrapping.length > 0 ? wrapping : this.detachedLabel(control);
    const name = attr(control, "name") ?? "";
    const required = hasAttr(control, "required");
    if (control.tag === "select") {
      const multi = hasAttr(control, "multiple");
      const options: ChoiceOption[] = controlsOfTag(control, "option").map((option) => {
        const text = textContent(option).replace(/\s+/g, " ").trim();
        return {
          value: attr(option, "value") ?? text,
          label: [{ text }],
          checked: hasAttr(option, "selected"),
          disabled: hasAttr(option, "disabled"),
        };
      });
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
      this.addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
      return;
    }
    if (control.tag === "textarea") {
      this.addField({
        kind: "text",
        name,
        type: "textarea",
        multiline: true,
        label: label.length > 0 ? label : this.nameLabel(name),
        value: textContent(control).replace(/^\r?\n/, ""),
        placeholder: attr(control, "placeholder") ?? "",
        required,
        minLength: numberAttr(control, "minlength"),
        maxLength: numberAttr(control, "maxlength"),
        rows: numberAttr(control, "rows") ?? 4,
      });
      return;
    }
    const type = (attr(control, "type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS[type]) return;
    const value = attr(control, "value");
    if (type === "hidden") {
      if (name) this.hidden.push([name, value ?? ""]);
      return;
    }
    if (type === "radio" || type === "checkbox") {
      const option: ChoiceOption = {
        value: value ?? "on",
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: hasAttr(control, "checked"),
        disabled: hasAttr(control, "disabled"),
      };
      const key = `${type}\0${name}`;
      const group = this.groups.get(key);
      if (group) {
        group.field.options.push(option);
        group.field.required ||= required;
        return;
      }
      const field: ChoiceField = {
        kind: "choice",
        name,
        multi: type === "checkbox",
        select: false,
        other: false,
        label: [],
        options: [option],
        required,
      };
      this.groups.set(key, { field, section: this.section, block: this.addField(field) });
      return;
    }
    this.addField({
      kind: "text",
      name,
      type,
      multiline: false,
      label: label.length > 0 ? label : this.nameLabel(name),
      value: value ?? "",
      placeholder: attr(control, "placeholder") ?? "",
      required,
      min: numberAttr(control, "min"),
      max: numberAttr(control, "max"),
      pattern: attr(control, "pattern") ?? undefined,
      minLength: numberAttr(control, "minlength"),
      maxLength: numberAttr(control, "maxlength"),
      rows: 1,
    });
  }
}

function controlsOfTag(node: HtmlNode, tag: string): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (current: HtmlNode) => {
    for (const child of current.children) {
      if (child.type === "element" && child.tag === tag) found.push(child);
      if (child.type === "element") visit(child);
    }
  };
  visit(node);
  return found;
}

/** Parse a form tree. Content outside the first `<form>` is ignored when one exists. */
export function parseHtmlFormTree(root: HtmlNode): HtmlForm {
  const form = root.tag === "form" ? root : findFirst(root, (node) => node.type === "element" && node.tag === "form") ?? root;
  return new FormBuilder(form).build();
}

function domToHtmlNode(node: Node): HtmlNode | null {
  if (node.nodeType === 3) {
    return { type: "text", tag: "", text: node.textContent ?? "", attrs: {}, children: [] };
  }
  if (node.nodeType === 8) return { type: "comment", tag: "", text: "", attrs: {}, children: [] };
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const attrs: Record<string, string> = {};
  for (const attribute of element.attributes) attrs[attribute.name.toLowerCase()] = attribute.value;
  return {
    type: "element",
    tag: element.localName,
    text: "",
    attrs,
    children: Array.from(element.childNodes).flatMap((child) => {
      const converted = domToHtmlNode(child);
      return converted ? [converted] : [];
    }),
  };
}

/** Parse agent-written form HTML in the renderer. Requires DOMParser. */
export function parseHtmlForm(html: string): HtmlForm {
  if (typeof DOMParser === "undefined") throw new Error("parseHtmlForm requires a DOM");
  const document = new DOMParser().parseFromString(html, "text/html");
  const root = domToHtmlNode(document);
  return parseHtmlFormTree(root ?? { type: "element", tag: "form", text: "", attrs: {}, children: [] });
}
