import test from "node:test";
import assert from "node:assert/strict";
import {
  getTranscriptJumpTargetKind,
  pickTranscriptJumpIndex,
  pickTranscriptViewportAnchorIndex
} from "../src/web/transcript-navigation.js";

test("getTranscriptJumpTargetKind only marks user and final assistant messages", () => {
  assert.equal(getTranscriptJumpTargetKind({ kind: "message", role: "user", text: "需求" }), "user");
  assert.equal(
    getTranscriptJumpTargetKind({ kind: "message", role: "assistant", phase: "final_answer", text: "总结" }),
    "assistant-final"
  );
  assert.equal(getTranscriptJumpTargetKind({ kind: "message", role: "assistant", phase: "commentary" }), null);
  assert.equal(getTranscriptJumpTargetKind({ kind: "message", role: "developer" }), null);
  assert.equal(getTranscriptJumpTargetKind({ kind: "message", role: "user", isContextPrelude: true }), null);
  assert.equal(getTranscriptJumpTargetKind({ kind: "reasoning", text: "..." }), null);
});

test("pickTranscriptJumpIndex prefers the anchored neighbor during repeated jumps", () => {
  assert.equal(pickTranscriptJumpIndex([-120, 0, 260], 1, 1), 2);
  assert.equal(pickTranscriptJumpIndex([-120, 0, 260], -1, 1), 0);
  assert.equal(pickTranscriptJumpIndex([-120, 0, 260], 1, 2), 2);
  assert.equal(pickTranscriptJumpIndex([-120, 0, 260], -1, 0), 0);
});

test("pickTranscriptJumpIndex falls back to viewport-relative selection without an anchor", () => {
  assert.equal(pickTranscriptJumpIndex([-180, -12, 48, 210], 1, null, 24), 2);
  assert.equal(pickTranscriptJumpIndex([-180, -12, 48, 210], -1, null, 24), 1);
  assert.equal(pickTranscriptJumpIndex([40, 120], -1, null, 24), 0);
  assert.equal(pickTranscriptJumpIndex([-220, -40], 1, null, 24), 1);
  assert.equal(pickTranscriptJumpIndex([], 1), -1);
});

test("pickTranscriptViewportAnchorIndex prefers the item around the viewport reference line", () => {
  assert.equal(
    pickTranscriptViewportAnchorIndex(
      [
        { top: 71, bottom: 373 },
        { top: 471, bottom: 629 },
        { top: 697, bottom: 1450 }
      ],
      1100
    ),
    1
  );
  assert.equal(
    pickTranscriptJumpIndex(
      [71, 471, 697],
      1,
      pickTranscriptViewportAnchorIndex(
        [
          { top: 71, bottom: 373 },
          { top: 471, bottom: 629 },
          { top: 697, bottom: 1450 }
        ],
        1100
      )
    ),
    2
  );
  assert.equal(
    pickTranscriptViewportAnchorIndex(
      [
        { top: 396, bottom: 740 },
        { top: 1087, bottom: 1340 }
      ],
      900
    ),
    0
  );
  assert.equal(
    pickTranscriptViewportAnchorIndex(
      [
        { top: -180, bottom: -12 },
        { top: 48, bottom: 210 },
        { top: 240, bottom: 360 }
      ],
      900
    ),
    2
  );
  assert.equal(pickTranscriptViewportAnchorIndex([{ top: 960, bottom: 1200 }], 900), null);
});
