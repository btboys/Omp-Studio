import assert from "node:assert/strict";
import { parse } from "parse5";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const formModule = await import(`${pathToFileURL(resolve("src/renderer/src/lib/html-form.ts")).href}?test=${Date.now()}`);
const { parseHtmlFormTree, initialDraft, submittedFormData, draftErrors, safeImageSrc } = formModule;

function fromParse5(node) {
  if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
    return { type: "element", tag: "#document", text: "", attrs: {}, children: (node.childNodes || []).map(fromParse5) };
  }
  if (node.nodeName === "#text") return { type: "text", tag: "", text: node.value || "", attrs: {}, children: [] };
  if (node.nodeName === "#comment") return { type: "comment", tag: "", text: "", attrs: {}, children: [] };
  const attrs = {};
  for (const attr of node.attrs || []) attrs[String(attr.name).toLowerCase()] = attr.value;
  return {
    type: "element",
    tag: String(node.tagName || node.nodeName).toLowerCase(),
    text: "",
    attrs,
    children: (node.childNodes || []).map(fromParse5),
  };
}

function parseHtml(html) {
  return parseHtmlFormTree(fromParse5(parse(html)));
}

const ask = parseHtml(`
  <p>ignore me</p>
  <form>
    <script>alert(1)</script>
    <fieldset>
      <legend>Which database?</legend>
      <label><input type="radio" name="q1" value="Postgres" checked> Postgres</label>
      <label><input type="radio" name="q1" value="SQLite"> SQLite</label>
    </fieldset>
    <fieldset>
      <legend>Extras</legend>
      <label><input type="checkbox" name="flags" value="wal"> WAL</label>
      <label><input type="checkbox" name="flags" value="fk"> Foreign keys</label>
    </fieldset>
    <label>Port <input type="number" name="port" value="5432" min="1" required></label>
    <textarea name="notes" placeholder="why"></textarea>
    <input type="hidden" name="token" value="abc">
    <input type="file" name="upload">
    <select name="env"><option>dev</option><option selected>prod</option></select>
  </form>
  <form><input name="second" value="no"></form>
`);

assert.equal(ask.fields.some((field) => field.name === "second" || field.name === "upload"), false, "second form and file inputs are not fields");
assert.deepEqual(ask.hidden, [["token", "abc"]]);
const radio = ask.fields.find((field) => field.name === "q1");
assert.equal(radio.kind, "choice");
assert.equal(radio.other, true, "a two-option radio group gets Other");
assert.equal(radio.options[0].checked, true);
const flags = ask.fields.find((field) => field.name === "flags");
assert.equal(flags.multi, true);
const env = ask.fields.find((field) => field.name === "env");
assert.deepEqual(env.options.map((option) => [option.value, option.checked]), [["dev", false], ["prod", true]]);

const draft = initialDraft(ask);
const data = submittedFormData(ask, draft);
assert.equal(data.token, "abc");
assert.equal(data.q1, "Postgres");
assert.deepEqual(data.flags, []);
assert.equal(data.port, 5432);
assert.equal(data.notes, "");
assert.equal(data.env, "prod");
assert.equal("second" in data, false);

const other = structuredClone(draft);
const radioIndex = ask.fields.indexOf(radio);
other.checked[radioIndex] = [];
other.other[radioIndex] = " mysql ";
assert.equal(submittedFormData(ask, other).q1, "mysql");

const required = parseHtml(`<form><input name="name" required></form>`);
const empty = initialDraft(required);
assert.equal(draftErrors(required, empty)[0], "Required");
empty.text[0] = "ada";
assert.deepEqual(draftErrors(required, empty), {});

assert.equal(safeImageSrc("javascript:alert(1)"), null);
assert.equal(safeImageSrc("file:///etc/passwd"), null);
assert.equal(safeImageSrc("https://example.com/a.png"), "https://example.com/a.png");

const bare = parseHtml(`<label>Name <input name="name" value="ada"></label>`);
assert.equal(bare.fields[0].name, "name");
assert.equal(bare.fields[0].value, "ada");
assert.equal(submittedFormData(bare, initialDraft(bare)).name, "ada");

console.log("html form tests passed");
