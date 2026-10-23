export function createDraft(box, valid) {
    let value = box.value;
    let start = value.length;
    let end = start;
    let needsSpace = Boolean(value && !/\s$/.test(value));
    let edited = false;
    let composing = false;
    let closed = false;

    function reconcile() {
        const next = box.value;
        if (next === value) {
            return;
        }

        let prefix = 0;
        while (prefix < value.length && prefix < next.length && value[prefix] === next[prefix]) {
            prefix += 1;
        }

        let suffix = 0;
        while (
            suffix < value.length - prefix &&
            suffix < next.length - prefix &&
            value[value.length - suffix - 1] === next[next.length - suffix - 1]
        ) {
            suffix += 1;
        }

        const oldEnd = value.length - suffix;
        const delta = next.length - value.length;
        const overlaps = prefix < end && oldEnd > start;
        const insertionInside = prefix === oldEnd && prefix > start && prefix < end;

        if (overlaps || insertionInside) {
            edited = true;
        } else if (oldEnd <= start) {
            start += delta;
            end += delta;
        }

        value = next;
    }

    function onInput() {
        if (!composing) {
            reconcile();
        }
    }

    function onCompositionStart() {
        composing = true;
    }

    function onCompositionEnd() {
        composing = false;
        reconcile();
    }

    box.addEventListener("input", onInput);
    box.addEventListener("compositionstart", onCompositionStart);
    box.addEventListener("compositionend", onCompositionEnd);

    return {
        update(text) {
            if (text === "") {
                return false;
            }

            if (closed || composing || edited || !valid() || !box.isConnected) {
                return false;
            }

            reconcile();
            if (edited) {
                return false;
            }

            let selectionStart = box.selectionStart;
            let selectionEnd = box.selectionEnd;
            const wasAtEnd = selectionStart === end && selectionEnd === end;
            if (needsSpace) {
                box.value = value.slice(0, start) + " " + value.slice(end);
                value = box.value;
                if (selectionStart >= end) {
                    selectionStart += 1;
                    selectionEnd += 1;
                }
                start += 1;
                end += 1;
                needsSpace = false;
            }

            const previousEnd = end;
            const delta = text.length - (previousEnd - start);
            box.value = value.slice(0, start) + text + value.slice(end);
            end = start + text.length;
            value = box.value;
            box.dispatchEvent(new Event("input", { bubbles: true }));

            if (
                typeof box.setSelectionRange === "function" &&
                selectionStart != null &&
                selectionEnd != null
            ) {
                if (wasAtEnd) {
                    box.setSelectionRange(end, end);
                } else {
                    const adjust = (position) => {
                        if (position <= start) {
                            return position;
                        }
                        if (position < previousEnd) {
                            return start + Math.min(position - start, text.length);
                        }
                        return position + delta;
                    };
                    box.setSelectionRange(adjust(selectionStart), adjust(selectionEnd));
                }
            }

            return true;
        },
        close() {
            if (closed) {
                return;
            }

            closed = true;
            box.removeEventListener("input", onInput);
            box.removeEventListener("compositionstart", onCompositionStart);
            box.removeEventListener("compositionend", onCompositionEnd);
        },
        get edited() {
            return edited;
        },
    };
}
