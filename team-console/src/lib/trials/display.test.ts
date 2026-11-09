import { describe, expect, it } from "vite-plus/test";

import { formatRuntime, storedImage } from "./display";

describe("formatRuntime", () => {
  it.each([
    [12, "12 ms"],
    [34.5, "35 ms"],
    [19.9, "20 ms"],
    [0, "0 ms"],
  ])("shows %s as whole milliseconds", (durationMs, expected) => {
    expect(formatRuntime(durationMs)).toBe(expected);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "shows %s as missing",
    (durationMs) => {
      expect(formatRuntime(durationMs)).toBe("-");
    },
  );
});

describe("storedImage", () => {
  it("keeps a data URL", () => {
    const image = "data:image/jpeg;base64,pano";
    expect(storedImage(image)).toBe(image);
  });

  it.each(["[image stored]", "", undefined])("has no image for %j", (value) => {
    expect(storedImage(value)).toBeUndefined();
  });
});
