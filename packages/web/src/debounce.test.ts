import { describe, expect, it, mock } from "bun:test";
import { debounce } from "./search.js";

describe("debounce", () => {
  it("calls the function after the specified delay", async () => {
    const fn = mock(() => {});
    const debounced = debounce(fn, 50);

    debounced();
    expect(fn).not.toHaveBeenCalled(); // not yet

    await Bun.sleep(80);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rapid calls only trigger the function once (last call wins)", async () => {
    const fn = mock((_val: string) => {});
    const debounced = debounce(fn, 50);

    debounced("a");
    debounced("b");
    debounced("c");

    await Bun.sleep(80);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("cancel() prevents the pending execution", async () => {
    const fn = mock(() => {});
    const debounced = debounce(fn, 50);

    debounced();
    debounced.cancel();

    await Bun.sleep(80);
    expect(fn).not.toHaveBeenCalled();
  });

  it("works correctly with different delay values", async () => {
    const fast = mock(() => {});
    const slow = mock(() => {});

    const debouncedFast = debounce(fast, 30);
    const debouncedSlow = debounce(slow, 120);

    debouncedFast();
    debouncedSlow();

    await Bun.sleep(60);
    // fast should have fired, slow should not yet
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).not.toHaveBeenCalled();

    await Bun.sleep(100);
    // now slow should have fired too
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
