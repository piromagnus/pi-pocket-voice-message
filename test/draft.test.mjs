import test from "node:test";
import assert from "node:assert/strict";
import { createDraft } from "../voice-message/draft.js";

class FakeTextarea extends EventTarget {
    value = "";
    isConnected = true;
    selectionStart = 0;
    selectionEnd = 0;
    inputEvents = 0;

    dispatchEvent(event) {
        if (event.type === "input") {
            this.inputEvents += 1;
        }
        return super.dispatchEvent(event);
    }

    setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    input(value) {
        this.value = value;
        this.selectionStart = value.length;
        this.selectionEnd = value.length;
        this.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

const setup = (initial = "") => {
    const box = new FakeTextarea();
    box.value = initial;
    box.setSelectionRange(initial.length, initial.length);
    const draft = createDraft(box, () => true);
    return { box, draft };
};

test("replaces provisional text and commits final text in the owned span", () => {
    const { box, draft } = setup("Keep this");
    assert.equal(draft.update("first"), true);
    assert.equal(box.value, "Keep this first");
    assert.equal(draft.update("final words"), true);
    assert.equal(box.value, "Keep this final words");
    assert.equal(draft.edited, false);
});

test("moves the owned range around edits before and after it", () => {
    const { box, draft } = setup("prefix");
    draft.update("speech");
    box.input(`new ${box.value}`);
    box.input(`${box.value} suffix`);
    assert.equal(draft.update("revised"), true);
    assert.equal(box.value, "new prefix revised suffix");
});

test("preserves an overlapping manual correction and stops replacing", () => {
    const { box, draft } = setup();
    draft.update("speech");
    box.input("speach");
    assert.equal(draft.edited, true);
    assert.equal(draft.update("corrected"), false);
    assert.equal(box.value, "speach");
});

test("does not relocate an overlap to a duplicate occurrence", () => {
    const { box, draft } = setup();
    draft.update("word word");
    box.input("ward word");
    assert.equal(draft.edited, true);
    assert.equal(draft.update("corrected"), false);
    assert.equal(box.value, "ward word");
});

test("empty final text does not add a separator or clear a preview", () => {
    const empty = setup("existing");
    assert.equal(empty.draft.update(""), false);
    assert.equal(empty.box.value, "existing");

    const preview = setup();
    preview.draft.update("preview");
    assert.equal(preview.draft.update(""), false);
    assert.equal(preview.box.value, "preview");
});

test("does not resurrect a cleared or sent draft", () => {
    const { box, draft } = setup();
    draft.update("speech");
    box.input("");
    assert.equal(draft.update("late result"), false);
    assert.equal(box.value, "");
});

test("preserves selection and does not need focus", () => {
    const { box, draft } = setup("abc");
    box.setSelectionRange(1, 2);
    draft.update("one");
    assert.equal(box.value, "abc one");
    assert.deepEqual([box.selectionStart, box.selectionEnd], [1, 2]);
    draft.update("longer");
    assert.deepEqual([box.selectionStart, box.selectionEnd], [1, 2]);
});

test("clamps a selection inside the owned span to the updated text", () => {
    const { box, draft } = setup();
    draft.update("abcdef");
    box.setSelectionRange(2, 5);
    draft.update("xy");
    assert.deepEqual([box.selectionStart, box.selectionEnd], [2, 2]);
});

test("rejects invalid or disconnected scopes", () => {
    const box = new FakeTextarea();
    let isValid = false;
    const draft = createDraft(box, () => isValid);
    assert.equal(draft.update("no"), false);
    isValid = true;
    box.isConnected = false;
    assert.equal(draft.update("no"), false);
    assert.equal(box.value, "");
});

test("does not apply a final update during composition", () => {
    const { box, draft } = setup();
    draft.update("preview");
    box.dispatchEvent(new Event("compositionstart"));
    assert.equal(draft.update("final"), false);
    assert.equal(box.value, "preview");
    box.dispatchEvent(new Event("compositionend"));
    assert.equal(draft.update("final"), true);
    assert.equal(box.value, "final");
});

test("detects manual edits made during composition", () => {
    const { box, draft } = setup();
    draft.update("hello");
    box.dispatchEvent(new Event("compositionstart"));
    box.value = "hellö";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("compositionend"));
    assert.equal(draft.edited, true);
    assert.equal(draft.update("again"), false);
    assert.equal(box.value, "hellö");
});

test("close removes listeners and keeps the preview text", () => {
    const { box, draft } = setup();
    draft.update("keep me");
    draft.close();
    box.input("manual text");
    assert.equal(draft.update("late"), false);
    assert.equal(box.value, "manual text");
});
