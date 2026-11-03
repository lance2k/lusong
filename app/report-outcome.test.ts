import { describe, expect, it } from "vitest";
import { photoOutcomeLine, RECORDING_STOPPED_LINE, voiceOutcomeLine } from "./report-outcome";

describe("a report's outcome, told after the rider left the Report view (S3D-4)", () => {
  it("a saved photo report is told in the reading's own lines", () => {
    expect(photoOutcomeLine({ report: { passability: "Not passable to light vehicles (MMDA gauge, Metro Manila)", effect: "It counts for 3 hours." } })).toBe(
      "Lusong read your photo: Not passable to light vehicles (MMDA gauge, Metro Manila). It counts for 3 hours.",
    );
  });

  it("a failed send is told with its own message", () => {
    expect(photoOutcomeLine({ message: "Lusong couldn't be reached." })).toBe("Lusong couldn't be reached.");
    expect(voiceOutcomeLine({ message: "Something went wrong." })).toBe("Something went wrong.");
  });

  it("a voice note is told with what Lusong heard and its effect", () => {
    expect(voiceOutcomeLine({ report: { heard: "Lusong heard that vehicles can't pass.", effect: "It counts for 3 hours." } })).toBe(
      "Lusong heard that vehicles can't pass. It counts for 3 hours.",
    );
  });

  it("a recording cut short by leaving is never sent, and says so", () => {
    expect(RECORDING_STOPPED_LINE).toBe("Recording stopped; nothing was sent.");
  });
});
