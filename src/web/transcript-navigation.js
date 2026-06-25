export function getTranscriptJumpTargetKind(item) {
  if (item?.kind !== "message") {
    return null;
  }

  if (item.role === "user" && item.isContextPrelude !== true) {
    return "user";
  }

  if (item.role === "assistant" && item.phase === "final_answer") {
    return "assistant-final";
  }

  return null;
}

export function pickTranscriptViewportAnchorIndex(rects, viewportHeight, referenceRatio = 0.4) {
  const numericViewportHeight = Number(viewportHeight);
  const normalizedRects = (Array.isArray(rects) ? rects : [])
    .map((rect, index) => {
      const top = Number(rect?.top);
      const bottom = Number(rect?.bottom);

      if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
        return null;
      }

      return {
        index,
        top,
        bottom,
        midpoint: (top + bottom) / 2
      };
    })
    .filter(Boolean)
    .filter((rect) => rect.bottom > 0 && rect.top < numericViewportHeight);

  if (
    normalizedRects.length === 0 ||
    !Number.isFinite(numericViewportHeight) ||
    numericViewportHeight <= 0
  ) {
    return null;
  }

  const numericReferenceRatio = Number.isFinite(referenceRatio) ? referenceRatio : 0.4;
  const referenceLine = Math.max(0, Math.min(numericViewportHeight, numericViewportHeight * numericReferenceRatio));
  const containingRect = normalizedRects.find((rect) => rect.top <= referenceLine && rect.bottom >= referenceLine);

  if (containingRect) {
    return containingRect.index;
  }

  let bestRect = normalizedRects[0];
  let bestDistance = Math.abs(bestRect.midpoint - referenceLine);

  for (let index = 1; index < normalizedRects.length; index += 1) {
    const rect = normalizedRects[index];
    const distance = Math.abs(rect.midpoint - referenceLine);

    if (distance < bestDistance) {
      bestRect = rect;
      bestDistance = distance;
      continue;
    }

    if (distance === bestDistance && rect.top < bestRect.top) {
      bestRect = rect;
    }
  }

  return bestRect.index;
}

export function pickTranscriptJumpIndex(offsets, direction, anchorIndex = null, threshold = 24) {
  const numericOffsets = Array.isArray(offsets) ? offsets : [];

  if (numericOffsets.length === 0) {
    return -1;
  }

  if (Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex < numericOffsets.length) {
    return Math.max(0, Math.min(numericOffsets.length - 1, anchorIndex + (direction < 0 ? -1 : 1)));
  }

  if (direction < 0) {
    for (let index = numericOffsets.length - 1; index >= 0; index -= 1) {
      if (numericOffsets[index] < threshold) {
        return index;
      }
    }

    return 0;
  }

  for (let index = 0; index < numericOffsets.length; index += 1) {
    if (numericOffsets[index] > threshold) {
      return index;
    }
  }

  return numericOffsets.length - 1;
}
