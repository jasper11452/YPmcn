import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reciprocalRankFusion } from "../dist/vector/rrf.js";

describe("reciprocalRankFusion", () => {
  it("fuses unique IDs and rewards candidates present in both lists", () => {
    const dense = [
      { id: "a", score: 0.9, payload: { label: "A" } },
      { id: "b", score: 0.8, payload: { label: "B" } },
      { id: "c", score: 0.7, payload: { label: "C" } },
    ];
    const sparse = [
      { id: "b", score: 1, payload: { label: "B" } },
      { id: "c", score: 0.9, payload: { label: "C" } },
      { id: "d", score: 0.8, payload: { label: "D" } },
    ];
    const fused = reciprocalRankFusion(dense, sparse, 60);
    assert.deepEqual(new Set(fused.map(({ id }) => id)), new Set(["a", "b", "c", "d"]));
    assert.equal(fused[0].id, "b");
  });

  it("preserves a single list and accepts empty inputs", () => {
    assert.deepEqual(reciprocalRankFusion([], [], 60), []);
    const single = reciprocalRankFusion([
      { id: "x", score: 1, payload: {} },
      { id: "y", score: 0.5, payload: {} },
    ], [], 60);
    assert.deepEqual(single.map(({ id }) => id), ["x", "y"]);
  });
});

