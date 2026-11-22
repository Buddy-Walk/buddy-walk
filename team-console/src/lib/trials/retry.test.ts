import { validate, version } from "uuid";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { trialFrom } from "./fixtures";
import {
  elapsedText,
  forgetPendingRetry,
  newIdempotencyKey,
  originalIdOf,
  readPendingRetries,
  retryAnswerFrom,
  retryBlockedReason,
  retryPollInterval,
  savePendingRetry,
  sendUntilAnswered,
  type RetryAnswer,
  type RetryRun,
} from "./retry";
import type { Trial } from "./schema";

const done: RetryAnswer = { ok: true, trialId: "retry-1" };
const inProgress: RetryAnswer = {
  ok: false,
  message: "This retry is still running.",
  code: "retry_in_progress",
  resend: false,
};
const gatewayError: RetryAnswer = { ok: false, message: "HTTP 502", resend: true };
const refused: RetryAnswer = {
  ok: false,
  message: "Retries are off.",
  code: "original_retry_running",
  resend: false,
};

const RUN: RetryRun = {
  key: "0192f0c0-0000-7000-8000-000000000002",
  trialId: "cvs",
  originalId: "cvs",
  name: "CVS Pharmacy",
  panoramaMode: "fresh",
  startedAt: 0,
};

/** Answers in order, advancing a fake clock by each wait. */
function script(answers: (RetryAnswer | Error)[]) {
  let time = 0;
  const waits: number[] = [];
  let sends = 0;
  return {
    send: async () => {
      const answer = answers[sends++];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    options: {
      now: () => time,
      wait: async (ms: number) => {
        waits.push(ms);
        time += ms;
      },
    },
    get sends() {
      return sends;
    },
    waits,
  };
}

describe("newIdempotencyKey", () => {
  it("makes a new UUIDv7 each time, which mobile/server requires", () => {
    const [first, second] = [newIdempotencyKey(), newIdempotencyKey()];
    expect(validate(first) && version(first)).toBe(7);
    expect(first).not.toBe(second);
  });
});

describe("sendUntilAnswered", () => {
  const run: RetryRun = {
    key: "0192f0c0-0000-7000-8000-000000000001",
    trialId: "retry-of-cvs",
    originalId: "cvs",
    name: "CVS Pharmacy",
    panoramaMode: "original",
    startedAt: 1000,
  };

  it("repeats the retry's key and request on every send", async () => {
    const sent: unknown[] = [];
    const answers = [new TypeError("Failed to fetch"), gatewayError, inProgress, done];
    const post = async (request: unknown) => {
      sent.push(request);
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    await sendUntilAnswered(run, post, { wait: async () => undefined });
    expect(sent).toEqual(
      Array.from({ length: 4 }, () => ({
        trialId: "retry-of-cvs",
        panoramaMode: "original",
        idempotencyKey: "0192f0c0-0000-7000-8000-000000000001",
      })),
    );
  });

  it("returns the first answer that finishes the retry", async () => {
    const scripted = script([done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).resolves.toEqual(done);
    expect(scripted.sends).toBe(1);
  });

  it("sends again after a dropped connection, five seconds later", async () => {
    const scripted = script([new TypeError("Failed to fetch"), done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).resolves.toEqual(done);
    expect(scripted.waits).toEqual([5000]);
  });

  it("sends again after a gateway error", async () => {
    const scripted = script([gatewayError, gatewayError, done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).resolves.toEqual(done);
    expect(scripted.sends).toBe(3);
  });

  it("does not send a refusal again, and fails with its message and code", async () => {
    const scripted = script([refused, done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).rejects.toMatchObject({
      message: "Retries are off.",
      code: "original_retry_running",
    });
    expect(scripted.sends).toBe(1);
  });

  it("waits out a run in progress for however long it takes", async () => {
    // Forty 5-second waits is 200 seconds, past the three minutes an unreachable server gets.
    const scripted = script([...Array.from({ length: 40 }, () => inProgress), done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).resolves.toEqual(done);
    expect(scripted.sends).toBe(41);
  });

  it("gives up once the server has been unreachable for three minutes", async () => {
    const failure = new TypeError("Failed to fetch");
    const scripted = script(Array.from({ length: 100 }, () => failure));
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).rejects.toThrow(
      "Failed to fetch",
    );
    // Sends at 0s, 5s ... 180s are within the limit, and the one at 185s is past it.
    expect(scripted.sends).toBe(38);
  });

  it("counts the three minutes from the last time the server answered", async () => {
    const down = Array.from({ length: 30 }, () => gatewayError);
    // 150 seconds of gateway errors, a sign of life, then 150 more, within the limit each time.
    const scripted = script([...down, inProgress, ...down, done]);
    await expect(sendUntilAnswered(RUN, scripted.send, scripted.options)).resolves.toEqual(done);
  });
});

describe("retryAnswerFrom", () => {
  it("reads a finished retry's new Trial and result", () => {
    expect(
      retryAnswerFrom(201, {
        testLogId: "retry-1",
        data: { testScenario: "exact", success: false, error: "No panorama", steps: [] },
      }),
    ).toEqual({
      ok: true,
      trialId: "retry-1",
      result: { testScenario: "exact", success: false, error: "No panorama" },
    });
  });

  it("reads a finished retry whose log could not be loaded", () => {
    expect(retryAnswerFrom(201, { testLogId: "retry-1", data: null })).toEqual({
      ok: true,
      trialId: "retry-1",
      result: {},
    });
  });

  it("fails a finished retry in an unexpected shape rather than reporting success", () => {
    expect(retryAnswerFrom(201, { data: null })).toMatchObject({ ok: false, resend: false });
    expect(retryAnswerFrom(201, undefined)).toMatchObject({ ok: false, resend: false });
  });

  it("keeps a refusal's message and code, and does not send it again", () => {
    expect(
      retryAnswerFrom(409, {
        error: "Retry with a fresh panorama.",
        code: "original_panorama_retired",
      }),
    ).toEqual({
      ok: false,
      message: "Retry with a fresh panorama.",
      code: "original_panorama_retired",
      resend: false,
    });
  });

  it.each([502, 503, 504])(
    "sends again after a %i from a proxy, which has no JSON error",
    (status) => {
      expect(retryAnswerFrom(status, undefined)).toEqual({
        ok: false,
        message: `HTTP ${status}`,
        resend: true,
      });
    },
  );

  it("does not send again after a 503 that mobile/server explained", () => {
    expect(retryAnswerFrom(503, { error: "Last Meters is unavailable." })).toMatchObject({
      message: "Last Meters is unavailable.",
      resend: false,
    });
  });

  it("does not send again after other errors without a body", () => {
    expect(retryAnswerFrom(500, undefined)).toMatchObject({ message: "HTTP 500", resend: false });
  });
});

describe("pending retries", () => {
  const run: RetryRun = {
    key: "0192f0c0-0000-7000-8000-000000000001",
    trialId: "retry-of-cvs",
    originalId: "cvs",
    name: "CVS Pharmacy",
    panoramaMode: "original",
    startedAt: 1000,
  };
  const other: RetryRun = { ...run, key: "second-key", trialId: "kohls", originalId: "kohls" };

  function stubStorage(initial?: string) {
    let value = initial ?? null;
    vi.stubGlobal("sessionStorage", {
      getItem: () => value,
      setItem: (_: string, next: string) => {
        value = next;
      },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives back each saved retry, so a reload can send it again with its key", () => {
    stubStorage();
    savePendingRetry(run);
    savePendingRetry(other);
    expect(readPendingRetries()).toEqual([run, other]);
  });

  it("forgets a retry once it has a final answer", () => {
    stubStorage();
    savePendingRetry(run);
    savePendingRetry(other);
    forgetPendingRetry(run.originalId);
    expect(readPendingRetries()).toEqual([other]);
  });

  it("leaves out an entry it can't read, and keeps the rest", () => {
    stubStorage(JSON.stringify({ cvs: { name: "no key" }, kohls: other }));
    expect(readPendingRetries()).toEqual([other]);
  });

  it("reads corrupt storage as no pending retries", () => {
    stubStorage("{not json");
    expect(readPendingRetries()).toEqual([]);
  });

  it("works without storage, where a reload only loses the result toast", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => savePendingRetry(run)).not.toThrow();
    expect(() => forgetPendingRetry(run.originalId)).not.toThrow();
    expect(readPendingRetries()).toEqual([]);
  });
});

describe("originalIdOf", () => {
  it("is a Trial's own id when it is an original", () => {
    expect(originalIdOf({ _id: "cvs" })).toBe("cvs");
  });

  it("is the root original for a retry, so retrying a retry groups with it", () => {
    expect(originalIdOf({ _id: "retry-2", retryOf: "cvs" })).toBe("cvs");
  });
});

describe("retryBlockedReason", () => {
  const withReplay = (replay: { status: Trial["replay"]["status"]; reason?: string }) =>
    trialFrom({
      replay: { defaultsApplied: [], originalPanorama: { available: false }, ...replay },
    });
  const replayable = withReplay({ status: "replayable" });
  const on = { available: true };

  it("is empty for a Trial that can be replayed", () => {
    expect(retryBlockedReason(replayable, on)).toBe("");
  });

  it("is empty for a replay that fills in values", () => {
    const trial = trialFrom({
      replay: {
        status: "replayable_with_defaults",
        defaultsApplied: ["compass accuracy level 3"],
        originalPanorama: { available: false },
      },
    });
    expect(retryBlockedReason(trial, on)).toBe("");
  });

  it("gives the server's reason when retries are off", () => {
    expect(
      retryBlockedReason(replayable, { available: false, reason: "Set OPENAI_API_KEY." }),
    ).toBe("Set OPENAI_API_KEY.");
  });

  it("says retries are off when the server gives no reason", () => {
    expect(retryBlockedReason(replayable, { available: false })).toBe(
      "Retries are off on this server.",
    );
  });

  it("gives the reason a Trial can't be replayed", () => {
    const trial = withReplay({ status: "not_replayable", reason: "The photo was not stored." });
    expect(retryBlockedReason(trial, on)).toBe("The photo was not stored.");
  });

  it("has a reason for a Trial that can't be replayed and doesn't say why", () => {
    const trial = withReplay({ status: "not_replayable" });
    expect(retryBlockedReason(trial, on)).toBe("This Trial cannot be replayed.");
  });

  it("puts retries being off ahead of the Trial's own reason", () => {
    const trial = withReplay({ status: "not_replayable", reason: "No photo." });
    expect(retryBlockedReason(trial, { available: false, reason: "Off." })).toBe("Off.");
  });
});

describe("retryPollInterval", () => {
  const running = { panoramaMode: "fresh", startedAt: 1000 } as const;

  it("polls every 15 seconds while the server reports a retry running", () => {
    expect(retryPollInterval([undefined, running], false)).toBe(15000);
  });

  it("polls while this tab has a retry running", () => {
    expect(retryPollInterval([undefined], true)).toBe(15000);
  });

  it("is off when nothing is running", () => {
    expect(retryPollInterval([undefined, undefined], false)).toBe(false);
    expect(retryPollInterval([], false)).toBe(false);
  });
});

describe("elapsedText", () => {
  it("counts whole seconds", () => {
    expect(elapsedText(1000, 13_400)).toBe("12s");
  });

  it("never goes below zero when the server's clock is ahead", () => {
    expect(elapsedText(5000, 1000)).toBe("0s");
  });
});
