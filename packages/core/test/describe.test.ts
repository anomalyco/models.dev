import { describe, expect, test } from "bun:test";

import { describeModel } from "../src/describe.js";

const IMAGE = "Image model for prompt-driven generation, editing, and visual design workflows";
const VIDEO = "Video model for prompt-guided generation, editing, and motion workflows";

describe("describeModel modality routing", () => {
  test("video output wins over an image keyword in the name", () => {
    expect(describeModel({
      id: "bfl/flux-3-video",
      name: "Flux 3",
      family: "flux",
      modalities: { input: ["text", "image"], output: ["video"] },
    })).toBe(VIDEO);
  });

  test("image models keep the image description", () => {
    expect(describeModel({
      id: "bfl/flux-2-pro",
      name: "FLUX.2 [pro]",
      family: "flux",
      modalities: { input: ["text"], output: ["image"] },
    })).toBe(IMAGE);
  });

  test("image-to-video models are described as video", () => {
    expect(describeModel({
      id: "alibaba/wan-v2.6-i2v",
      name: "Wan v2.6 Image-to-Video",
      modalities: { input: ["text", "image"], output: ["video"] },
    })).toBe(VIDEO);
  });

  test("video models without a video keyword still resolve by modality", () => {
    expect(describeModel({
      id: "bytedance/seedance-2.0",
      name: "Seedance 2.0",
      modalities: { input: ["text"], output: ["video"] },
    })).toBe(VIDEO);
  });
});
