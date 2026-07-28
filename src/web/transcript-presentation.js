export function groupTranscriptItems(items) {
  const sourceItems = Array.isArray(items) ? items : [];
  const entries = [];

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const nextItem = sourceItems[index + 1];

    if (
      item?.kind === "tool_call" &&
      item.callId &&
      nextItem?.kind === "tool_output" &&
      nextItem.callId === item.callId
    ) {
      entries.push({
        kind: "tool_interaction",
        call: item,
        output: nextItem
      });
      index += 1;
      continue;
    }

    entries.push({
      kind: "single",
      item
    });
  }

  return entries;
}

export function groupTranscriptItemsWithRanges(items, startIndex = 0) {
  const sourceItems = Array.isArray(items) ? items : [];
  const entries = [];

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const nextItem = sourceItems[index + 1];
    const absoluteIndex = startIndex + index;

    if (
      item?.kind === "tool_call" &&
      item.callId &&
      nextItem?.kind === "tool_output" &&
      nextItem.callId === item.callId
    ) {
      entries.push({
        kind: "tool_interaction",
        call: item,
        output: nextItem,
        startIndex: absoluteIndex,
        endIndex: absoluteIndex + 2
      });
      index += 1;
      continue;
    }

    entries.push({
      kind: "single",
      item,
      startIndex: absoluteIndex,
      endIndex: absoluteIndex + 1
    });
  }

  return entries;
}

export function getTranscriptEntryTimestamp(entry) {
  if (entry?.kind === "tool_interaction") {
    return entry.output?.timestamp || entry.call?.timestamp || "";
  }

  return entry?.item?.timestamp || "";
}

export function splitEntriesIntoDisplaySegments(entries, isVisibleEntry) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const visiblePredicate = typeof isVisibleEntry === "function" ? isVisibleEntry : () => false;
  const segments = [];
  let hiddenEntries = [];

  function flushHiddenEntries() {
    if (hiddenEntries.length === 0) {
      return;
    }

    segments.push({
      kind: "process",
      entries: hiddenEntries
    });
    hiddenEntries = [];
  }

  sourceEntries.forEach((entry, index) => {
    if (visiblePredicate(entry, index)) {
      flushHiddenEntries();
      segments.push({
        kind: "visible",
        entry
      });
      return;
    }

    hiddenEntries.push(entry);
  });

  flushHiddenEntries();

  return segments;
}
