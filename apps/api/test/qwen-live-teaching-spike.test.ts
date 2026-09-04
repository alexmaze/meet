import { once } from "node:events";

import { QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS } from "@meet/protocol";
import WebSocket, { type ClientOptions, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  QWEN_LIVE_TEACHING_EXACT_FIXTURES,
  QWEN_LIVE_TEACHING_EXACT_MARKERS,
  TEACHING_SPIKE_FIXTURE_CATALOG,
  TEACHING_SPIKE_FIXTURES,
  TEACHING_SPIKE_FIXTURE_HASH,
  TEACHING_SPIKE_FIXTURE_REVISION,
  TEACHING_SPIKE_USER_TEXT_HASH,
  compileTeachingInstructions,
  hashTeachingFixture,
  hashTeachingSpikeFixtureCatalog,
} from "../src/spikes/realtime-teaching/fixtures.js";
import {
  QwenTeachingLiveAdapterError,
  QWEN_TEACHING_LIVE_CHECKPOINTS,
  QWEN_TEACHING_LIVE_MAX_INBOX_DEPTH,
  QWEN_TEACHING_LIVE_MAX_RESPONSE_MS,
  QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_BYTES,
  QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_EVENTS,
  QWEN_TEACHING_LIVE_MAX_TRANSCRIPT_CHARACTERS,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES,
  QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES,
  getQwenTeachingLiveMarkerFailureObservation,
  runQwenTeachingTextProtocolSmoke,
  type QwenTeachingLiveTimeouts,
} from "../src/spikes/realtime-teaching/qwen-live-adapter.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Qwen teaching live protocol smoke adapter", () => {
  it("binds fixture revision .4 to independent exact Qwen state instructions", () => {
    expect(TEACHING_SPIKE_FIXTURE_REVISION).toBe("2026-08-14.4");
    expect(QWEN_LIVE_TEACHING_EXACT_MARKERS).toStrictEqual({
      A: "A7K2",
      B: "B4M8",
      C: "C9P3",
    });
    const markers = Object.values(QWEN_LIVE_TEACHING_EXACT_MARKERS);
    for (const [index, marker] of markers.entries()) {
      for (const [candidateIndex, candidate] of markers.entries()) {
        if (index === candidateIndex) continue;
        expect(marker).not.toContain(candidate);
      }
    }
    for (const shared of [
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.neutralBase.text,
      TEACHING_SPIKE_FIXTURES.safety.text,
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
    ]) {
      for (const marker of markers) expect(shared).not.toContain(marker);
    }
    const instructions = compileFixtureInstructions();
    for (const [state, text] of Object.entries(instructions)) {
      const expectedMarker =
        QWEN_LIVE_TEACHING_EXACT_MARKERS[
          state.slice(-1).toUpperCase() as "A" | "B" | "C"
        ];
      expect(countOccurrences(text, expectedMarker)).toBe(1);
      for (const marker of markers) {
        if (marker !== expectedMarker) expect(text).not.toContain(marker);
      }
    }
    expect(TEACHING_SPIKE_USER_TEXT_HASH).toBe(
      hashTeachingFixture(QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text),
    );
    expect(TEACHING_SPIKE_FIXTURE_HASH).toBe(
      hashTeachingFixture(JSON.stringify(TEACHING_SPIKE_FIXTURE_CATALOG)),
    );
    expect(TEACHING_SPIKE_FIXTURE_HASH).toBe(hashTeachingSpikeFixtureCatalog());
  });

  it("publishes a fixed allowlist of non-sensitive diagnostic checkpoints", () => {
    expect(QWEN_TEACHING_LIVE_CHECKPOINTS).toEqual([
      "adapter_setup",
      "session_1_connect",
      "session_1_session_created",
      "session_1_voice_update_ack",
      "session_1_input_audio_format_update_ack",
      "session_1_output_audio_format_update_ack",
      "session_1_smart_turn_update_ack",
      "session_1_max_history_turns_update_ack",
      "session_1_modalities_update_ack",
      "session_1_base_instructions_update_ack",
      "session_1_base_update_ack",
      "d01t_directive_update_ack",
      "d01t_case",
      "d02t_restore_update_ack",
      "d02t_case",
      "session_1_close",
      "session_2_connect",
      "session_2_session_created",
      "session_2_voice_update_ack",
      "session_2_input_audio_format_update_ack",
      "session_2_output_audio_format_update_ack",
      "session_2_smart_turn_update_ack",
      "session_2_max_history_turns_update_ack",
      "session_2_modalities_update_ack",
      "session_2_base_instructions_update_ack",
      "session_2_base_update_ack",
      "d03t_directive_a_update_ack",
      "d03t_directive_b_update_ack",
      "d03t_case",
      "d03t_restore_update_ack",
      "session_2_close",
    ]);
  });

  it("publishes fixed safe Provider error category allowlists", () => {
    expect(QWEN_TEACHING_LIVE_PROVIDER_ERROR_TYPE_CATEGORIES).toEqual([
      "invalid_request",
      "server",
      "missing",
      "unrecognized",
    ]);
    expect(QWEN_TEACHING_LIVE_PROVIDER_ERROR_CODE_CATEGORIES).toEqual([
      "invalid_value",
      "missing",
      "unrecognized",
    ]);
    expect(QWEN_TEACHING_LIVE_PROVIDER_ERROR_PARAM_CATEGORIES).toEqual([
      "session_update",
      "session_configuration",
      "conversation_item_create",
      "response_create",
      "missing",
      "unrecognized",
    ]);
  });

  it.each([
    [0, 0, "session_1_modalities_update_ack", 0],
    [0, 1, "d01t_directive_update_ack", 0],
    [0, 2, "d02t_restore_update_ack", 1],
    [1, 0, "session_2_modalities_update_ack", 0],
    [1, 1, "d03t_directive_a_update_ack", 0],
    [1, 2, "d03t_directive_b_update_ack", 0],
    [1, 3, "d03t_restore_update_ack", 1],
  ] as const)(
    "stops at session %i update %i with checkpoint %s",
    async (sessionIndex, updateIndex, checkpoint, responsesBeforeFailure) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        providerErrorAtUpdate: {
          sessionIndex,
          updateIndex,
          error: {
            type: "invalid_request_error",
            code: "invalid_value",
            message: "unsafe Provider detail",
            param: "session.instructions",
          },
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "PROVIDER_ERROR",
        checkpoint,
        providerError: {
          typeCategory: "invalid_request",
          codeCategory: "invalid_value",
          paramCategory: "session_configuration",
        },
      });
      expect(
        fake.receivedTypes[sessionIndex]?.filter(
          (type) => type === "response.create",
        ),
      ).toHaveLength(responsesBeforeFailure);
      expect(fake.receivedTypes[sessionIndex]?.at(-1)).toBe("session.update");
      expect(fake.connectionCount).toBe(sessionIndex + 1);
      if (responsesBeforeFailure === 0) {
        expect(fake.receivedTypes[sessionIndex]).not.toContain(
          "conversation.item.create",
        );
      }
    },
  );

  it.each([
    ["session id", { id: "session_wrong" }],
    ["model", { model: "qwen-wrong-model" }],
    ["text modality", { modalities: ["audio", "text"] }],
  ] as const)(
    "requires every instructions ACK to preserve %s",
    async (_field, patch) => {
      const fake = await startFakeUpstream({
        responseTexts: [["unused"], ["unused"]],
        sessionAckPatchAt: {
          sessionIndex: 0,
          updateIndex: 1,
          patch,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "SESSION_CONFIGURATION_MISMATCH",
        checkpoint: "d01t_directive_update_ack",
      });
      expect(fake.receivedUserTexts).toEqual([]);
    },
  );

  it("strictly rejects a modalities ACK that remains non-text", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      wrongAckAtUpdate: { sessionIndex: 0, updateIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "SESSION_CONFIGURATION_MISMATCH",
      checkpoint: "session_1_modalities_update_ack",
    });
    expect(fake.receivedUserTexts).toEqual([]);
    expect(fake.connectionCount).toBe(1);
  });

  it.each([
    ["wrong hash", "错误指令", "INSTRUCTION_ACK_MISMATCH"],
    ["empty", "", "INSTRUCTION_ACK_MISMATCH"],
    ["invalid", 42, "INVALID_SESSION_UPDATED_EVENT"],
  ] as const)(
    "fails closed on a %s explicit instructions ACK",
    async (_label, value, code) => {
      const fake = await startFakeUpstream({
        responseTexts: [["unused"], ["unused"]],
        instructionAckOverrideAt: {
          sessionIndex: 0,
          updateIndex: 1,
          value,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code,
        checkpoint: "d01t_directive_update_ack",
      });
      expect(fake.receivedUserTexts).toEqual([]);
      expect(fake.connectionCount).toBe(1);
    },
  );

  it.each([
    [
      {
        type: "invalid_request_error",
        code: "invalid_value",
        param: "session.update",
      },
      {
        typeCategory: "invalid_request",
        codeCategory: "invalid_value",
        paramCategory: "session_update",
      },
    ],
    [
      { type: "server_error", param: "conversation.item.create" },
      {
        typeCategory: "server",
        codeCategory: "missing",
        paramCategory: "conversation_item_create",
      },
    ],
    [
      { code: "invalid_value", param: "response.create" },
      {
        typeCategory: "missing",
        codeCategory: "invalid_value",
        paramCategory: "response_create",
      },
    ],
    [
      { type: null, code: 42, param: ["session.voice"] },
      {
        typeCategory: "unrecognized",
        codeCategory: "unrecognized",
        paramCategory: "unrecognized",
      },
    ],
  ] as const)(
    "maps a real Provider error shape to closed safe categories",
    async (providerError, expected) => {
      const fake = await startFakeUpstream({
        responseTexts: [["unused"], ["unused"]],
        providerErrorAtUpdate: {
          sessionIndex: 0,
          updateIndex: 0,
          error: { ...providerError, message: "must never escape" },
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error.providerError).toStrictEqual(expected);
      expect(JSON.stringify(error)).not.toContain("must never escape");
    },
  );

  it("does not propagate hostile Provider fields, event ids, configuration, or cause text", async () => {
    const forbidden = [
      "test-only-key",
      "realtime.example.com",
      TEACHING_SPIKE_FIXTURES.base.text,
      TEACHING_SPIKE_FIXTURES.userText.text,
      "provider_event_secret",
    ];
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      providerErrorAtUpdate: {
        sessionIndex: 0,
        updateIndex: 0,
        eventId: forbidden[4],
        error: {
          type: forbidden[0],
          code: forbidden[1],
          param: forbidden[3],
          message: forbidden.join(" | "),
          instructions: forbidden[2],
          cause: new Error("nested secret"),
        },
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      checkpoint: "session_1_modalities_update_ack",
      providerError: {
        typeCategory: "unrecognized",
        codeCategory: "unrecognized",
        paramCategory: "unrecognized",
      },
    });
    const serialized = JSON.stringify(error);
    for (const secret of forbidden) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("nested secret");
  });

  it("rejects timeout overrides above the fixed safety ceilings before opening a socket", async () => {
    let factoryCalls = 0;
    await expect(
      runQwenTeachingTextProtocolSmoke({
        endpoint: "realtime.example.com",
        apiKey: "test-only-key",
        model: "qwen-audio-3.0-realtime-plus",
        voice: "longanqian",
        webSocketFactory: () => {
          factoryCalls += 1;
          throw new Error("must not open");
        },
        timeouts: { responseDoneMs: 15_001 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
      checkpoint: "adapter_setup",
    });
    expect(factoryCalls).toBe(0);
  });

  it.each([
    ["first", 0, "session_1_connect"],
    ["second", 1, "session_2_connect"],
  ] as const)(
    "reports a safe checkpoint when the %s session transport factory fails",
    async (_label, failAtSession, checkpoint) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
      });
      const forbidden = [
        "realtime.secret.example",
        "secret-api-key",
        "secret user body",
        "secret system instructions",
        "provider_event_secret",
      ];
      let factoryCalls = 0;

      const error = await captureAdapterError(() =>
        runQwenTeachingTextProtocolSmoke({
          endpoint: forbidden[0]!,
          apiKey: forbidden[1]!,
          model: "qwen-audio-3.0-realtime-plus",
          voice: "longanqian",
          webSocketFactory: (_url, options) => {
            const sessionIndex = factoryCalls;
            factoryCalls += 1;
            if (sessionIndex === failAtSession) {
              throw new Error(forbidden.slice(2).join(" | "));
            }
            return fake.createClient(options);
          },
          timeouts: testTimeouts(),
        }),
      );

      expect(error).toMatchObject({ code: "NETWORK_ERROR", checkpoint });
      expect(error.message).toBe("NETWORK_ERROR");
      const serialized = JSON.stringify(error);
      for (const secret of forbidden) expect(serialized).not.toContain(secret);
    },
  );

  it.each([
    ["first", 0, "session_1_session_created"],
    ["second", 1, "session_2_session_created"],
  ] as const)(
    "reports a safe checkpoint for an invalid %s session.created envelope",
    async (_label, invalidAtSession, checkpoint) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        overlongSessionCreatedEventIdAt: invalidAtSession,
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({ code: "INVALID_SERVER_EVENT", checkpoint });
      expect(JSON.stringify(error)).not.toContain(
        "e".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
      );
    },
  );

  it("accepts five explicit matching instructions echoes", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      instructionAckMode: "echo",
    });

    const result = await runAndCaptureResult(fake);
    expect(result.instructionAcks).toStrictEqual({
      total: 5,
      echoedMatch: 5,
      omitted: 0,
    });
  });

  it("records a mixed set of echoed and omitted instructions ACKs", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      echoInstructionAcksAt: [
        { sessionIndex: 0, updateIndex: 1 },
        { sessionIndex: 1, updateIndex: 2 },
      ],
    });

    const result = await runAndCaptureResult(fake);
    expect(result.instructionAcks).toStrictEqual({
      total: 5,
      echoedMatch: 2,
      omitted: 3,
    });
  });

  it.each([
    [0, 0, "d01t_case"],
    [0, 1, "d02t_case"],
    [1, 0, "d03t_case"],
  ] as const)(
    "binds session %i response %i failure to checkpoint %s",
    async (sessionIndex, responseIndex, checkpoint) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        wrongUserItemAckAt: { sessionIndex, responseIndex },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "USER_ITEM_ACK_MISMATCH",
        checkpoint,
      });
    },
  );

  it.each([
    ["first", 0, "session_1_close"],
    ["second", 1, "session_2_close"],
  ] as const)(
    "binds a stuck %s session close to checkpoint %s",
    async (_label, stuckAtSession, checkpoint) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        stuckClientCloseAtSession: stuckAtSession,
      });

      const error = await runAndCaptureError(fake, { socketCloseMs: 1 });
      expect(error).toMatchObject({
        code: "SOCKET_CLOSE_TIMEOUT",
        checkpoint,
      });
    },
  );

  it("runs D01T+D02T and D03T in two clean scripted upstream sessions", async () => {
    const fixtureInstructions = compileFixtureInstructions();
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
    });
    const requestedUrls: string[] = [];

    const result = await runQwenTeachingTextProtocolSmoke({
      endpoint: "realtime.example.com",
      apiKey: "test-only-key",
      model: "qwen-audio-3.0-realtime-plus",
      voice: "longanqian",
      webSocketFactory: (url, options) => {
        requestedUrls.push(url);
        return fake.createClient(options);
      },
      timeouts: testTimeouts(),
    });

    expect(result).toStrictEqual({
      schemaVersion: 3,
      provider: "qwen",
      inputMode: "text",
      fixtureRevision: TEACHING_SPIKE_FIXTURE_REVISION,
      fixtureHash: TEACHING_SPIKE_FIXTURE_HASH,
      inputFixtureHash: TEACHING_SPIKE_USER_TEXT_HASH,
      scope: {
        transport: "isolated_provider_websocket",
        relayExercised: false,
        browserExercised: false,
      },
      providerEvidence: false,
      upstreamSessions: 2,
      responseAttempts: 3,
      instructionAcks: {
        total: 5,
        echoedMatch: 0,
        omitted: 5,
      },
      usage: {
        totalTokens: 48,
        inputTokens: 30,
        outputTokens: 18,
        inputTextTokens: 30,
        inputAudioTokens: 0,
        outputTextTokens: 18,
        outputAudioTokens: 0,
      },
      cases: [
        {
          id: "D01T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D02T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
        {
          id: "D03T",
          status: "protocol_sequence_completed",
          expectedMarkerCount: 1,
          forbiddenMarkerCount: 0,
        },
      ],
    });
    expect(requestedUrls).toEqual([
      "wss://realtime.example.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
      "wss://realtime.example.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    ]);
    expect(fake.authorizationHeaders).toEqual([
      "Bearer test-only-key",
      "Bearer test-only-key",
    ]);
    expect(fake.receivedTypes).toEqual([
      [
        "session.update",
        "session.update",
        "conversation.item.create",
        "response.create",
        "session.update",
        "conversation.item.create",
        "response.create",
      ],
      [
        "session.update",
        "session.update",
        "session.update",
        "conversation.item.create",
        "response.create",
        "session.update",
      ],
    ]);
    for (const event of fake.receivedClientEvents.flat()) {
      expect(event).not.toHaveProperty("event_id");
      if (event.type === "session.update") {
        const sessionKeys = Object.keys(readRecord(event.session));
        expect(sessionKeys).toHaveLength(1);
        expect(["modalities", "instructions"]).toContain(sessionKeys[0]);
      }
    }
    expect(fake.receivedInstructions).toEqual([
      [fixtureInstructions.stateA, fixtureInstructions.stateC],
      [
        fixtureInstructions.stateA,
        fixtureInstructions.stateB,
        fixtureInstructions.stateC,
      ],
    ]);
    expect(fake.receivedUserTexts).toEqual([
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
    ]);
    expect(fake.receivedSessionModalities).toEqual([["text"], ["text"]]);
    expect(fake.receivedResponseModalities).toEqual([
      ["text"],
      ["text"],
      ["text"],
    ]);
    expect(new Set(fake.receivedUserItemIds).size).toBe(3);
    expect(fake.receivedUserItemIds).toHaveLength(3);
    for (const itemId of fake.receivedUserItemIds) {
      expect(itemId).toMatch(/^item_[0-9a-f-]{36}$/u);
    }
    expect(fake.maxConcurrentConnections).toBe(1);
    expect(fake.activeConnections).toBe(0);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
    );
    expect(serialized).not.toContain(fixtureInstructions.stateA);
    expect(serialized).not.toContain("读取状态");
    expect(serialized).not.toContain("realtime.example.com");
    expect(serialized).not.toContain("test-only-key");
  });

  it("accepts exact tokens with only peripheral whitespace", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [
        [
          ` \n${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}\t`,
          ` ${QWEN_LIVE_TEACHING_EXACT_MARKERS.C}\n`,
        ],
        [`\t${QWEN_LIVE_TEACHING_EXACT_MARKERS.B} `],
      ],
    });

    await expect(runAndCaptureResult(fake)).resolves.toMatchObject({
      schemaVersion: 3,
      cases: [
        { id: "D01T", expectedMarkerCount: 1, forbiddenMarkerCount: 0 },
        { id: "D02T", expectedMarkerCount: 1, forbiddenMarkerCount: 0 },
        { id: "D03T", expectedMarkerCount: 1, forbiddenMarkerCount: 0 },
      ],
    });
  });

  it.each([
    ["missing", "没有状态", { a: "zero", b: "zero", c: "zero" }],
    [
      "repeated",
      `${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}`,
      { a: "multiple", b: "zero", c: "zero" },
    ],
    [
      "wrong state",
      QWEN_LIVE_TEACHING_EXACT_MARKERS.C,
      { a: "zero", b: "zero", c: "one" },
    ],
    [
      "mixed states",
      `${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}${QWEN_LIVE_TEACHING_EXACT_MARKERS.B}`,
      { a: "one", b: "one", c: "zero" },
    ],
    [
      "extra text",
      `${QWEN_LIVE_TEACHING_EXACT_MARKERS.A}额外文字`,
      { a: "one", b: "zero", c: "zero" },
    ],
  ] as const)(
    "fails D01T on %s with a frozen allowlisted observation",
    async (_label, responseText, markerMultiplicity) => {
      const responseTexts = successfulResponseTexts();
      responseTexts[0]![0] = responseText;
      const fake = await startFakeUpstream({ responseTexts });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "MARKER_ASSERTION_FAILED",
        caseId: "D01T",
        checkpoint: "d01t_case",
      });
      const observation = getQwenTeachingLiveMarkerFailureObservation(error);
      expect(observation).toStrictEqual({
        caseId: "D01T",
        expectedState: "A",
        activeInstructionAck: "omitted",
        observedInstructionAcks: {
          total: 1,
          echoedMatch: 0,
          omitted: 1,
        },
        markerMultiplicity,
        hasUnexpectedText: true,
        progress: { session: 1, attempt: 1, completed: 0, failed: 1 },
        usage: singleResponseUsage(),
      });
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.isFrozen(observation?.observedInstructionAcks)).toBe(true);
      expect(Object.isFrozen(observation?.markerMultiplicity)).toBe(true);
      expect(Object.isFrozen(observation?.progress)).toBe(true);
      expect(Object.isFrozen(observation?.usage)).toBe(true);
      expect(Object.keys(observation ?? {})).toStrictEqual([
        "caseId",
        "expectedState",
        "activeInstructionAck",
        "observedInstructionAcks",
        "markerMultiplicity",
        "hasUnexpectedText",
        "progress",
        "usage",
      ]);
      expect(fake.connectionCount).toBe(1);
      expect(
        fake.receivedTypes[0]?.filter((type) => type === "response.create"),
      ).toHaveLength(1);
      expect(fake.activeConnections).toBe(0);
    },
  );

  it.each([
    [
      "D02T",
      0,
      1,
      QWEN_LIVE_TEACHING_EXACT_MARKERS.A,
      "C",
      2,
      { session: 1, attempt: 2, completed: 1, failed: 1 },
      "d02t_case",
    ],
    [
      "D03T",
      1,
      0,
      QWEN_LIVE_TEACHING_EXACT_MARKERS.C,
      "B",
      4,
      { session: 2, attempt: 3, completed: 2, failed: 1 },
      "d03t_case",
    ],
  ] as const)(
    "binds %s marker diagnostics to fixed ACK, progress, and cumulative usage",
    async (
      caseId,
      sessionIndex,
      responseIndex,
      responseText,
      expectedState,
      observedAckTotal,
      progress,
      checkpoint,
    ) => {
      const responseTexts = successfulResponseTexts();
      responseTexts[sessionIndex]![responseIndex] = responseText;
      const fake = await startFakeUpstream({ responseTexts });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "MARKER_ASSERTION_FAILED",
        caseId,
        checkpoint,
      });
      expect(getQwenTeachingLiveMarkerFailureObservation(error)).toMatchObject({
        caseId,
        expectedState,
        activeInstructionAck: "omitted",
        observedInstructionAcks: {
          total: observedAckTotal,
          echoedMatch: 0,
          omitted: observedAckTotal,
        },
        progress,
        usage: multipliedUsage(progress.attempt),
      });
    },
  );

  it("keeps hostile response text, prompts, ids, endpoints, keys, and markers out of diagnostics", async () => {
    const forbidden = [
      "test-only-key",
      "realtime.example.com",
      "provider_event_secret",
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateA.text,
      QWEN_LIVE_TEACHING_EXACT_FIXTURES.userText.text,
      ...Object.values(QWEN_LIVE_TEACHING_EXACT_MARKERS),
    ];
    const responseTexts = successfulResponseTexts();
    responseTexts[0]![0] = forbidden.join(" | ");
    const fake = await startFakeUpstream({
      responseTexts,
      instructionAckMode: "echo",
    });

    const error = await runAndCaptureError(fake);
    const observation = getQwenTeachingLiveMarkerFailureObservation(error);
    expect(observation).toMatchObject({
      activeInstructionAck: "echoed_match",
      observedInstructionAcks: { total: 1, echoedMatch: 1, omitted: 0 },
    });
    for (const serialized of [
      JSON.stringify(error),
      JSON.stringify(observation),
    ]) {
      for (const secret of forbidden) expect(serialized).not.toContain(secret);
    }
    expect(JSON.stringify(error)).not.toContain("markerMultiplicity");
    expect(JSON.stringify(error)).not.toContain("observedInstructionAcks");
  });

  it("does not accept a caller-forged marker observation", () => {
    const forged = new QwenTeachingLiveAdapterError(
      "MARKER_ASSERTION_FAILED",
      "D01T",
      "d01t_case",
    );
    Object.assign(forged, {
      markerFailureObservation: {
        caseId: "D01T",
        expectedState: "A",
        transcript: QWEN_LIVE_TEACHING_EXACT_MARKERS.A,
      },
    });

    expect(getQwenTeachingLiveMarkerFailureObservation(forged)).toBeUndefined();
  });

  it("keeps a fixed response timeout and a finite text-event session ceiling", () => {
    expect(QWEN_TEACHING_LIVE_MAX_RESPONSE_MS).toBe(15_000);
    expect(QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_EVENTS).toBe(2_048);
  });

  it("counts identical delta, transcript.done, and response.done text only once", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      includeTerminalTranscriptAt: { sessionIndex: 0, responseIndex: 0 },
    });

    await expect(runAndCaptureResult(fake)).resolves.toMatchObject({
      cases: [
        expect.objectContaining({ id: "D01T", expectedMarkerCount: 1 }),
        expect.objectContaining({ id: "D02T" }),
        expect.objectContaining({ id: "D03T" }),
      ],
    });
  });

  it.each([
    ["transcript.done", { transcriptDoneText: "不一致的完成文本" }],
    ["response.done", { terminalTranscript: "不一致的终态文本" }],
  ] as const)(
    "fails closed when %s disagrees with transcript deltas",
    async (_source, override) => {
      const fake = await startFakeUpstream({
        responseTexts: [["一致的流式文本"], ["unused"]],
        transcriptOverrideAt: {
          sessionIndex: 0,
          responseIndex: 0,
          ...override,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({ code: "RESPONSE_TRANSCRIPT_MISMATCH" });
      expect(fake.connectionCount).toBe(1);
      expect(fake.activeConnections).toBe(0);
    },
  );

  it("binds each user item ACK to the exact client-generated item id", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      wrongUserItemAckAt: { sessionIndex: 0, responseIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "USER_ITEM_ACK_MISMATCH" });
    expect(fake.receivedTypes[0]).toEqual([
      "session.update",
      "session.update",
      "conversation.item.create",
    ]);
    expect(fake.receivedUserItemIds).toHaveLength(1);
    expect(fake.activeConnections).toBe(0);
  });

  it("accepts null previous_item_id on the first user item ACK", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      userItemPreviousItemIdAt: {
        sessionIndex: 0,
        responseIndex: 0,
        value: null,
      },
    });

    const result = await runAndCaptureResult(fake);
    expect(result.cases).toHaveLength(3);
  });

  it("rejects a non-string, non-null previous_item_id on a user item ACK", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      userItemPreviousItemIdAt: {
        sessionIndex: 0,
        responseIndex: 0,
        value: 42,
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "INVALID_CONVERSATION_ITEM_CREATED_EVENT",
      checkpoint: "d01t_case",
    });
  });

  it("accepts response.created without modalities after text-only session confirmation", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      omitResponseCreatedModalitiesAt: {
        sessionIndex: 0,
        responseIndex: 0,
      },
    });

    const result = await runAndCaptureResult(fake);
    expect(result.cases).toHaveLength(3);
    expect(fake.receivedResponseModalities[0]).toEqual(["text"]);
  });

  it("rejects explicit audio modalities on response.created", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      responseCreatedModalitiesAt: {
        sessionIndex: 0,
        responseIndex: 0,
        modalities: ["audio", "text"],
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "RESPONSE_MODALITY_MISMATCH",
      checkpoint: "d01t_case",
    });
  });

  it("accepts the official four-event text response metadata sequence", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      includeTextResponseMetaAt: { sessionIndex: 0, responseIndex: 0 },
    });

    await expect(runAndCaptureResult(fake)).resolves.toMatchObject({
      schemaVersion: 3,
      cases: [
        { id: "D01T", expectedMarkerCount: 1, forbiddenMarkerCount: 0 },
        { id: "D02T" },
        { id: "D03T" },
      ],
    });
  });

  it.each([true, false])(
    "rejects undocumented response.future_event when response_id is present=%s",
    async (includeResponseId) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        unknownResponseEventAt: {
          sessionIndex: 0,
          responseIndex: 0,
          includeResponseId,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "UNEXPECTED_SERVER_EVENT",
        checkpoint: "d01t_case",
      });
      expect(fake.connectionCount).toBe(1);
    },
  );

  it.each([
    ["different active response", "response_wrong", "RESPONSE_ID_MISMATCH"],
    [
      "overlong response id",
      "r".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1),
      "INVALID_RESPONSE_OUTPUT_ITEM_ADDED_EVENT",
    ],
  ] as const)(
    "rejects response metadata with a %s",
    async (_label, responseId, code) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        includeTextResponseMetaAt: { sessionIndex: 0, responseIndex: 0 },
        responseMetaResponseIdOverrideAt: {
          sessionIndex: 0,
          responseIndex: 0,
          value: responseId,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({ code, checkpoint: "d01t_case" });
    },
  );

  it.each([
    ["malformed_shape", "INVALID_RESPONSE_OUTPUT_ITEM_ADDED_EVENT"],
    ["out_of_order", "UNEXPECTED_SERVER_EVENT"],
  ] as const)("rejects a response metadata %s fault", async (fault, code) => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      textResponseMetaFaultAt: {
        sessionIndex: 0,
        responseIndex: 0,
        fault,
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code, checkpoint: "d01t_case" });
  });

  it("rejects an audio content-part event explicitly in text-only mode", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      audioContentPartAtResponse: { sessionIndex: 0, responseIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "UNEXPECTED_AUDIO_OUTPUT",
      checkpoint: "d01t_case",
    });
  });

  it("requires response.text.done even when delta and response.done text are exact", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      omitTranscriptDoneAt: { sessionIndex: 0, responseIndex: 0 },
      includeTerminalTranscriptAt: { sessionIndex: 0, responseIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "RESPONSE_TEXT_DONE_MISSING",
      checkpoint: "d01t_case",
    });
    expect(fake.connectionCount).toBe(1);
  });

  it("rejects delta A -> text.done A -> delta extra -> response.done", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      lateResponseEventAfterTextDoneAt: {
        sessionIndex: 0,
        responseIndex: 0,
        kind: "text_delta",
        text: "extra",
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "UNEXPECTED_SERVER_EVENT",
      checkpoint: "d01t_case",
    });
    expect(getQwenTeachingLiveMarkerFailureObservation(error)).toBeUndefined();
  });

  it.each(["output_item_added", "content_part_added"] as const)(
    "rejects late response.%s after response.text.done",
    async (kind) => {
      const fake = await startFakeUpstream({
        responseTexts: successfulResponseTexts(),
        lateResponseEventAfterTextDoneAt: {
          sessionIndex: 0,
          responseIndex: 0,
          kind,
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({
        code: "UNEXPECTED_SERVER_EVENT",
        checkpoint: "d01t_case",
      });
    },
  );

  it("strictly validates optional response.done text output binding", async () => {
    const fake = await startFakeUpstream({
      responseTexts: successfulResponseTexts(),
      includeTerminalTranscriptAt: { sessionIndex: 0, responseIndex: 0 },
      terminalOutputItemPatchAt: {
        sessionIndex: 0,
        responseIndex: 0,
        patch: { role: "user" },
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "INVALID_RESPONSE_DONE_EVENT",
      checkpoint: "d01t_case",
    });
  });

  it("fails closed on an overlong provider event id", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      overlongSessionCreatedEventIdAt: 0,
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "INVALID_SERVER_EVENT" });
    expect(fake.connectionCount).toBe(1);
    expect(fake.activeConnections).toBe(0);
  });

  it("fails closed when a synchronous provider burst exceeds inbox depth", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      burstAfterSessionCreated: {
        sessionIndex: 0,
        count: QWEN_TEACHING_LIVE_MAX_INBOX_DEPTH * 4,
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "UPSTREAM_INBOX_OVERFLOW" });
    expect(fake.connectionCount).toBe(1);
    expect(fake.activeConnections).toBe(0);
    expect(JSON.stringify(error)).not.toContain("burst-payload");
  });

  it("keeps undocumented rate_limits.updated fail-closed", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      burstAfterSessionCreated: { sessionIndex: 0, count: 1 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "UNEXPECTED_SERVER_EVENT",
      checkpoint: "session_1_modalities_update_ack",
    });
    expect(fake.receivedUserTexts).toEqual([]);
  });

  it("fails closed when cumulative inbound bytes exceed the session budget", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      inboundPadding: {
        sessionIndex: 0,
        charactersPerEvent:
          Math.floor(QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_BYTES / 3) +
          100_000,
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "UPSTREAM_SESSION_BYTES_EXCEEDED",
    });
    expect(fake.receivedUserTexts).toEqual([]);
    expect(fake.activeConnections).toBe(0);
  });

  it("fails closed when cumulative inbound events exceed the session budget", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      pacedTranscriptEventsAtResponse: {
        sessionIndex: 0,
        responseIndex: 0,
        count: QWEN_TEACHING_LIVE_MAX_SESSION_INBOUND_EVENTS + 1,
      },
    });

    const error = await runAndCaptureError(fake, { responseDoneMs: 5_000 });
    expect(error).toMatchObject({
      code: "UPSTREAM_SESSION_EVENTS_EXCEEDED",
    });
    expect(fake.connectionCount).toBe(1);
    expect(fake.activeConnections).toBe(0);
  });

  it("closes with a fixed error when cumulative transcript text exceeds 32K", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [
        ["文".repeat(QWEN_TEACHING_LIVE_MAX_TRANSCRIPT_CHARACTERS + 1)],
        ["unused"],
      ],
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "RESPONSE_TRANSCRIPT_TOO_LARGE" });
    expect(error.message).toBe("RESPONSE_TRANSCRIPT_TOO_LARGE");
    expect(JSON.stringify(error)).not.toContain("文文文");
    expect(fake.receivedTypes).toHaveLength(1);
  });

  it("fails closed on any audio delta in the text-only smoke", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      audioBytesAtResponse: {
        sessionIndex: 0,
        responseIndex: 0,
        byteLength: 1,
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "UNEXPECTED_AUDIO_OUTPUT" });
    expect(error.message).toBe("UNEXPECTED_AUDIO_OUTPUT");
    expect(JSON.stringify(error)).not.toContain("test-only-key");
    expect(fake.receivedTypes).toHaveLength(1);
  });

  it("rejects a response.done event for a different response id", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      wrongDoneResponseIdAt: { sessionIndex: 0, responseIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "RESPONSE_ID_MISMATCH" });
  });

  it("rejects a non-completed response terminal state", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      failedResponseAt: { sessionIndex: 0, responseIndex: 0 },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "RESPONSE_NOT_COMPLETED" });
  });

  it("requires internally consistent usage on every completed response", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      usageAt: {
        sessionIndex: 0,
        responseIndex: 0,
        value: {
          total_tokens: 15,
          input_tokens: 10,
          output_tokens: 6,
          input_tokens_details: { text_tokens: 10 },
          output_tokens_details: { text_tokens: 2, audio_tokens: 4 },
        },
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE_DONE_EVENT" });
  });

  it.each([
    ["input", { input: 1, output: 0 }],
    ["output", { input: 0, output: 1 }],
  ] as const)(
    "rejects non-zero %s audio usage in text-only mode",
    async (_kind, audio) => {
      const fake = await startFakeUpstream({
        responseTexts: [["unused"], ["unused"]],
        usageAt: {
          sessionIndex: 0,
          responseIndex: 0,
          value: {
            total_tokens: 12,
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: {
              text_tokens: 10 - audio.input,
              audio_tokens: audio.input,
            },
            output_tokens_details: {
              text_tokens: 2 - audio.output,
              audio_tokens: audio.output,
            },
          },
        },
      });

      const error = await runAndCaptureError(fake);
      expect(error).toMatchObject({ code: "INVALID_RESPONSE_DONE_EVENT" });
    },
  );

  it("rejects usage beyond the pre-authorized cost reservation", async () => {
    const fake = await startFakeUpstream({
      responseTexts: [["unused"], ["unused"]],
      usageAt: {
        sessionIndex: 0,
        responseIndex: 0,
        value: {
          total_tokens: 16_385,
          input_tokens: 16_385,
          output_tokens: 0,
          input_tokens_details: { text_tokens: 16_385 },
          output_tokens_details: { text_tokens: 0, audio_tokens: 0 },
        },
      },
    });

    const error = await runAndCaptureError(fake);
    expect(error).toMatchObject({
      code: "RESPONSE_USAGE_EXCEEDS_RESERVATION",
    });
  });
});

type FakeUpstreamOptions = {
  responseTexts: string[][];
  stuckClientCloseAtSession?: number;
  wrongAckAtUpdate?: { sessionIndex: number; updateIndex: number };
  instructionAckMode?: "omit" | "echo";
  echoInstructionAcksAt?: ReadonlyArray<{
    sessionIndex: number;
    updateIndex: number;
  }>;
  instructionAckOverrideAt?: {
    sessionIndex: number;
    updateIndex: number;
    value: unknown;
  };
  sessionAckPatchAt?: {
    sessionIndex: number;
    updateIndex: number;
    patch: Record<string, unknown>;
  };
  providerErrorAtUpdate?: {
    sessionIndex: number;
    updateIndex: number;
    error: Record<string, unknown>;
    eventId?: string;
  };
  wrongUserItemAckAt?: { sessionIndex: number; responseIndex: number };
  userItemPreviousItemIdAt?: {
    sessionIndex: number;
    responseIndex: number;
    value: unknown;
  };
  omitResponseCreatedModalitiesAt?: {
    sessionIndex: number;
    responseIndex: number;
  };
  responseCreatedModalitiesAt?: {
    sessionIndex: number;
    responseIndex: number;
    modalities: string[];
  };
  overlongSessionCreatedEventIdAt?: number;
  burstAfterSessionCreated?: { sessionIndex: number; count: number };
  inboundPadding?: { sessionIndex: number; charactersPerEvent: number };
  pacedTranscriptEventsAtResponse?: {
    sessionIndex: number;
    responseIndex: number;
    count: number;
  };
  includeTerminalTranscriptAt?: {
    sessionIndex: number;
    responseIndex: number;
  };
  includeTextResponseMetaAt?: {
    sessionIndex: number;
    responseIndex: number;
  };
  responseMetaResponseIdOverrideAt?: {
    sessionIndex: number;
    responseIndex: number;
    value: string;
  };
  textResponseMetaFaultAt?: {
    sessionIndex: number;
    responseIndex: number;
    fault: "malformed_shape" | "out_of_order";
  };
  unknownResponseEventAt?: {
    sessionIndex: number;
    responseIndex: number;
    includeResponseId: boolean;
  };
  audioContentPartAtResponse?: {
    sessionIndex: number;
    responseIndex: number;
  };
  omitTranscriptDoneAt?: {
    sessionIndex: number;
    responseIndex: number;
  };
  lateResponseEventAfterTextDoneAt?: {
    sessionIndex: number;
    responseIndex: number;
    kind: "text_delta" | "output_item_added" | "content_part_added";
    text?: string;
  };
  terminalOutputItemPatchAt?: {
    sessionIndex: number;
    responseIndex: number;
    patch: Record<string, unknown>;
  };
  transcriptOverrideAt?: {
    sessionIndex: number;
    responseIndex: number;
    transcriptDoneText?: string;
    terminalTranscript?: string;
  };
  audioBytesAtResponse?: {
    sessionIndex: number;
    responseIndex: number;
    byteLength: number;
  };
  wrongDoneResponseIdAt?: { sessionIndex: number; responseIndex: number };
  failedResponseAt?: { sessionIndex: number; responseIndex: number };
  usageAt?: {
    sessionIndex: number;
    responseIndex: number;
    value: Record<string, unknown>;
  };
};

async function startFakeUpstream(options: FakeUpstreamOptions): Promise<{
  url: string;
  createClient(options: ClientOptions): WebSocket;
  authorizationHeaders: Array<string | undefined>;
  receivedTypes: string[][];
  receivedClientEvents: Array<Array<Record<string, unknown>>>;
  receivedInstructions: string[][];
  receivedUserTexts: string[];
  receivedUserItemIds: string[];
  receivedSessionModalities: string[][];
  receivedResponseModalities: string[][];
  readonly connectionCount: number;
  readonly activeConnections: number;
  readonly maxConcurrentConnections: number;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Fake Qwen upstream did not bind a TCP port.");
  }

  const authorizationHeaders: Array<string | undefined> = [];
  const receivedTypes: string[][] = [];
  const receivedClientEvents: Array<Array<Record<string, unknown>>> = [];
  const receivedInstructions: string[][] = [];
  const receivedUserTexts: string[] = [];
  const receivedUserItemIds: string[] = [];
  const receivedSessionModalities: string[][] = [];
  const receivedResponseModalities: string[][] = [];
  let connectionCount = 0;
  let activeConnections = 0;
  let maxConcurrentConnections = 0;
  let createdClientCount = 0;
  let eventSequence = 0;

  server.on("connection", (socket, request) => {
    const sessionIndex = connectionCount;
    connectionCount += 1;
    authorizationHeaders.push(request.headers.authorization);
    receivedTypes[sessionIndex] = [];
    receivedClientEvents[sessionIndex] = [];
    receivedInstructions[sessionIndex] = [];
    let updateIndex = 0;
    let responseIndex = 0;
    let sessionState = initialFakeSessionState();

    const send = (value: Record<string, unknown>, eventId?: string): void => {
      eventSequence += 1;
      const padding =
        options.inboundPadding?.sessionIndex === sessionIndex
          ? "p".repeat(options.inboundPadding.charactersPerEvent)
          : undefined;
      socket.send(
        JSON.stringify({
          event_id: eventId ?? `server_event_${eventSequence}`,
          ...value,
          ...(padding === undefined ? {} : { padding }),
        }),
      );
    };

    send(
      {
        type: "session.created",
        session: sessionSnapshot(`session_${sessionIndex + 1}`, sessionState),
      },
      options.overlongSessionCreatedEventIdAt === sessionIndex
        ? "e".repeat(QWEN_REALTIME_MAX_IDENTIFIER_CHARACTERS + 1)
        : undefined,
    );
    if (options.burstAfterSessionCreated?.sessionIndex === sessionIndex) {
      for (
        let index = 0;
        index < options.burstAfterSessionCreated.count;
        index += 1
      ) {
        send({ type: "rate_limits.updated", marker: "burst-payload" });
      }
    }

    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      const type = String(event.type);
      receivedTypes[sessionIndex]?.push(type);
      receivedClientEvents[sessionIndex]?.push(event);

      if (type === "session.update") {
        const sessionPatch = readRecord(event.session);
        if (Array.isArray(sessionPatch.modalities)) {
          receivedSessionModalities.push(sessionPatch.modalities.map(String));
        }
        if (typeof sessionPatch.instructions === "string") {
          receivedInstructions[sessionIndex]?.push(sessionPatch.instructions);
        }
        if (
          options.providerErrorAtUpdate?.sessionIndex === sessionIndex &&
          options.providerErrorAtUpdate.updateIndex === updateIndex
        ) {
          updateIndex += 1;
          send(
            {
              type: "error",
              error: options.providerErrorAtUpdate.error,
            },
            options.providerErrorAtUpdate.eventId,
          );
          return;
        }
        const skipPatch =
          options.wrongAckAtUpdate?.sessionIndex === sessionIndex &&
          options.wrongAckAtUpdate.updateIndex === updateIndex;
        if (!skipPatch) {
          sessionState = mergeFakeSessionPatch(sessionState, sessionPatch);
        }
        const sessionAck: Record<string, unknown> = sessionSnapshot(
          `session_${sessionIndex + 1}`,
          sessionState,
        );
        const echoInstructions =
          options.instructionAckMode === "echo" ||
          options.echoInstructionAcksAt?.some(
            (candidate) =>
              candidate.sessionIndex === sessionIndex &&
              candidate.updateIndex === updateIndex,
          ) === true;
        if (!echoInstructions) {
          delete sessionAck.instructions;
        }
        if (
          options.instructionAckOverrideAt?.sessionIndex === sessionIndex &&
          options.instructionAckOverrideAt.updateIndex === updateIndex
        ) {
          sessionAck.instructions = options.instructionAckOverrideAt.value;
        }
        if (
          options.sessionAckPatchAt?.sessionIndex === sessionIndex &&
          options.sessionAckPatchAt.updateIndex === updateIndex
        ) {
          Object.assign(sessionAck, options.sessionAckPatchAt.patch);
        }
        updateIndex += 1;
        send({
          type: "session.updated",
          session: sessionAck,
        });
        return;
      }

      if (type === "conversation.item.create") {
        const item = readRecord(event.item);
        const itemId = String(item.id);
        const content = Array.isArray(item.content) ? item.content : [];
        const first = readRecord(content[0]);
        receivedUserTexts.push(String(first.text));
        receivedUserItemIds.push(itemId);
        const overridePreviousItemId =
          options.userItemPreviousItemIdAt?.sessionIndex === sessionIndex &&
          options.userItemPreviousItemIdAt.responseIndex === responseIndex;
        send({
          type: "conversation.item.created",
          ...(overridePreviousItemId
            ? {
                previous_item_id: options.userItemPreviousItemIdAt?.value,
              }
            : {}),
          item: {
            id:
              options.wrongUserItemAckAt?.sessionIndex === sessionIndex &&
              options.wrongUserItemAckAt.responseIndex === responseIndex
                ? `${itemId}_wrong`
                : itemId,
            object: "realtime.item",
            type: "message",
            status: "completed",
            role: "user",
            content: [{ type: "input_text", text: first.text }],
          },
        });
        return;
      }

      if (type === "response.create") {
        const responseConfig = readRecord(event.response);
        receivedResponseModalities.push(
          Array.isArray(responseConfig.modalities)
            ? responseConfig.modalities.map(String)
            : [],
        );
        const currentResponseIndex = responseIndex;
        const responseId = `response_${sessionIndex}_${currentResponseIndex}`;
        const assistantItemId = `assistant_item_${sessionIndex}_${currentResponseIndex + 1}`;
        const responseText =
          options.responseTexts[sessionIndex]?.[currentResponseIndex] ?? "";
        const includeTextResponseMeta =
          options.includeTextResponseMetaAt?.sessionIndex === sessionIndex &&
          options.includeTextResponseMetaAt.responseIndex ===
            currentResponseIndex;
        const responseMetaFault =
          options.textResponseMetaFaultAt?.sessionIndex === sessionIndex &&
          options.textResponseMetaFaultAt.responseIndex === currentResponseIndex
            ? options.textResponseMetaFaultAt.fault
            : undefined;
        const responseMetaId =
          options.responseMetaResponseIdOverrideAt?.sessionIndex ===
            sessionIndex &&
          options.responseMetaResponseIdOverrideAt.responseIndex ===
            currentResponseIndex
            ? options.responseMetaResponseIdOverrideAt.value
            : responseId;
        const omitResponseCreatedModalities =
          options.omitResponseCreatedModalitiesAt?.sessionIndex ===
            sessionIndex &&
          options.omitResponseCreatedModalitiesAt.responseIndex ===
            currentResponseIndex;
        const responseCreatedModalities =
          options.responseCreatedModalitiesAt?.sessionIndex === sessionIndex &&
          options.responseCreatedModalitiesAt.responseIndex ===
            currentResponseIndex
            ? options.responseCreatedModalitiesAt.modalities
            : ["text"];
        responseIndex += 1;
        send({
          type: "response.created",
          response: {
            id: responseId,
            status: "in_progress",
            ...(omitResponseCreatedModalities
              ? {}
              : { modalities: responseCreatedModalities }),
            output: [],
          },
        });
        if (responseMetaFault === "out_of_order") {
          send({
            type: "response.content_part.added",
            response_id: responseMetaId,
            item_id: assistantItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "text", text: "" },
          });
        } else if (responseMetaFault === "malformed_shape") {
          send({
            type: "response.output_item.added",
            response_id: responseMetaId,
            output_index: 0,
            item: {
              id: assistantItemId,
              object: "realtime.item",
              type: "message",
              status: "in_progress",
              role: "user",
              content: [],
            },
          });
        } else if (includeTextResponseMeta) {
          send({
            type: "response.output_item.added",
            response_id: responseMetaId,
            output_index: 0,
            item: {
              id: assistantItemId,
              object: "realtime.item",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
        }
        send({
          type: "conversation.item.created",
          item: {
            id: assistantItemId,
            object: "realtime.item",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        if (includeTextResponseMeta) {
          send({
            type: "response.content_part.added",
            response_id: responseMetaId,
            item_id: assistantItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "text", text: "" },
          });
        }
        if (
          options.audioContentPartAtResponse?.sessionIndex === sessionIndex &&
          options.audioContentPartAtResponse.responseIndex ===
            currentResponseIndex
        ) {
          send({
            type: "response.content_part.added",
            response_id: responseId,
            item_id: assistantItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "audio", text: "" },
          });
        }
        if (
          options.unknownResponseEventAt?.sessionIndex === sessionIndex &&
          options.unknownResponseEventAt.responseIndex === currentResponseIndex
        ) {
          send({
            type: "response.future_event",
            ...(options.unknownResponseEventAt.includeResponseId
              ? { response_id: responseId }
              : {}),
          });
        }
        if (
          options.pacedTranscriptEventsAtResponse?.sessionIndex ===
            sessionIndex &&
          options.pacedTranscriptEventsAtResponse.responseIndex ===
            currentResponseIndex
        ) {
          let remaining = options.pacedTranscriptEventsAtResponse.count;
          const sendNext = (): void => {
            if (remaining <= 0 || socket.readyState !== WebSocket.OPEN) return;
            remaining -= 1;
            send({
              type: "response.text.delta",
              response_id: responseId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              delta: "",
            });
            if (remaining > 0) setImmediate(sendNext);
          };
          sendNext();
          return;
        }
        if (
          options.audioBytesAtResponse?.sessionIndex === sessionIndex &&
          options.audioBytesAtResponse.responseIndex === currentResponseIndex
        ) {
          send({
            type: "response.audio.delta",
            response_id: responseId,
            item_id: assistantItemId,
            output_index: 0,
            content_index: 0,
            delta: Buffer.alloc(
              options.audioBytesAtResponse.byteLength,
            ).toString("base64"),
          });
        }
        const finishResponse = (): void => {
          const transcriptOverride =
            options.transcriptOverrideAt?.sessionIndex === sessionIndex &&
            options.transcriptOverrideAt.responseIndex === currentResponseIndex
              ? options.transcriptOverrideAt
              : undefined;
          const splitAt = Math.max(1, Math.floor(responseText.length / 2));
          for (const delta of [
            responseText.slice(0, splitAt),
            responseText.slice(splitAt),
          ]) {
            if (!delta) continue;
            send({
              type: "response.text.delta",
              response_id: responseId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              delta,
            });
          }
          const transcriptDoneText =
            transcriptOverride?.transcriptDoneText ?? responseText;
          const omitTranscriptDone =
            options.omitTranscriptDoneAt?.sessionIndex === sessionIndex &&
            options.omitTranscriptDoneAt.responseIndex === currentResponseIndex;
          if (!omitTranscriptDone) {
            send({
              type: "response.text.done",
              response_id: responseId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              text: transcriptDoneText,
            });
          }
          const lateResponseEvent =
            options.lateResponseEventAfterTextDoneAt?.sessionIndex ===
              sessionIndex &&
            options.lateResponseEventAfterTextDoneAt.responseIndex ===
              currentResponseIndex
              ? options.lateResponseEventAfterTextDoneAt
              : undefined;
          if (lateResponseEvent?.kind === "text_delta") {
            send({
              type: "response.text.delta",
              response_id: responseId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              delta: lateResponseEvent.text ?? "extra",
            });
          } else if (lateResponseEvent?.kind === "output_item_added") {
            send({
              type: "response.output_item.added",
              response_id: responseId,
              output_index: 0,
              item: {
                id: assistantItemId,
                object: "realtime.item",
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
              },
            });
          } else if (lateResponseEvent?.kind === "content_part_added") {
            send({
              type: "response.content_part.added",
              response_id: responseId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              part: { type: "text", text: "" },
            });
          }
          if (includeTextResponseMeta) {
            send({
              type: "response.content_part.done",
              response_id: responseMetaId,
              item_id: assistantItemId,
              output_index: 0,
              content_index: 0,
              part: { type: "text", text: transcriptDoneText },
            });
            send({
              type: "response.output_item.done",
              response_id: responseMetaId,
              output_index: 0,
              item: {
                id: assistantItemId,
                object: "realtime.item",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "text", text: transcriptDoneText }],
              },
            });
          }
          const includeTerminalTranscript =
            options.includeTerminalTranscriptAt?.sessionIndex ===
              sessionIndex &&
            options.includeTerminalTranscriptAt.responseIndex ===
              currentResponseIndex;
          const terminalTranscript =
            transcriptOverride?.terminalTranscript ??
            (includeTerminalTranscript ? responseText : undefined);
          const usage =
            options.usageAt?.sessionIndex === sessionIndex &&
            options.usageAt.responseIndex === currentResponseIndex
              ? options.usageAt.value
              : {
                  total_tokens: 16,
                  input_tokens: 10,
                  output_tokens: 6,
                  input_tokens_details: {
                    text_tokens: 10,
                    audio_tokens: 0,
                  },
                  output_tokens_details: {
                    text_tokens: 6,
                    audio_tokens: 0,
                  },
                };
          const terminalOutputItem: Record<string, unknown> = {
            id: assistantItemId,
            object: "realtime.item",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "text", text: terminalTranscript }],
          };
          if (
            terminalTranscript !== undefined &&
            options.terminalOutputItemPatchAt?.sessionIndex === sessionIndex &&
            options.terminalOutputItemPatchAt.responseIndex ===
              currentResponseIndex
          ) {
            Object.assign(
              terminalOutputItem,
              options.terminalOutputItemPatchAt.patch,
            );
          }
          send({
            type: "response.done",
            response: {
              id:
                options.wrongDoneResponseIdAt?.sessionIndex === sessionIndex &&
                options.wrongDoneResponseIdAt.responseIndex ===
                  currentResponseIndex
                  ? `${responseId}_wrong`
                  : responseId,
              ...(options.failedResponseAt?.sessionIndex === sessionIndex &&
              options.failedResponseAt.responseIndex === currentResponseIndex
                ? { status: "failed", status_details: {} }
                : { status: "completed", modalities: ["text"], usage }),
              ...(terminalTranscript === undefined
                ? {}
                : {
                    output: [terminalOutputItem],
                  }),
            },
          });
        };

        finishResponse();
      }
    });
  });

  const url = `ws://127.0.0.1:${address.port}`;
  const createClient = (clientOptions: ClientOptions): WebSocket => {
    const clientIndex = createdClientCount;
    createdClientCount += 1;
    const client = new WebSocket(url, clientOptions);
    if (options.stuckClientCloseAtSession === clientIndex) {
      client.close = () => undefined;
      client.terminate = () => undefined;
    }
    activeConnections += 1;
    maxConcurrentConnections = Math.max(
      maxConcurrentConnections,
      activeConnections,
    );
    client.once("close", () => {
      activeConnections -= 1;
    });
    return client;
  };

  return {
    url,
    createClient,
    authorizationHeaders,
    receivedTypes,
    receivedClientEvents,
    receivedInstructions,
    receivedUserTexts,
    receivedUserItemIds,
    receivedSessionModalities,
    receivedResponseModalities,
    get connectionCount() {
      return connectionCount;
    },
    get activeConnections() {
      return activeConnections;
    },
    get maxConcurrentConnections() {
      return maxConcurrentConnections;
    },
  };
}

type FakeSessionState = {
  modalities: string[];
  voice: string;
  inputAudioFormat?: string;
  outputAudioFormat?: string;
  instructions?: string;
  maxHistoryTurns: number;
  turnDetection: { type: string };
};

function initialFakeSessionState(): FakeSessionState {
  return {
    modalities: ["audio", "text"],
    voice: "longanlingxin",
    maxHistoryTurns: 20,
    turnDetection: { type: "server_vad" },
  };
}

function mergeFakeSessionPatch(
  current: FakeSessionState,
  patch: Record<string, unknown>,
): FakeSessionState {
  const next: FakeSessionState = {
    ...current,
    modalities: [...current.modalities],
    turnDetection: { ...current.turnDetection },
  };
  if (Object.prototype.hasOwnProperty.call(patch, "voice")) {
    next.voice = String(patch.voice);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "input_audio_format")) {
    next.inputAudioFormat = String(patch.input_audio_format);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "output_audio_format")) {
    next.outputAudioFormat = String(patch.output_audio_format);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "turn_detection")) {
    const turnDetection = readRecord(patch.turn_detection);
    next.turnDetection = { type: String(turnDetection.type) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "max_history_turns")) {
    next.maxHistoryTurns = Number(patch.max_history_turns);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "modalities")) {
    next.modalities = Array.isArray(patch.modalities)
      ? patch.modalities.map(String)
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(patch, "instructions")) {
    next.instructions = String(patch.instructions);
  }
  return next;
}

function sessionSnapshot(id: string, state: FakeSessionState) {
  return {
    id,
    object: "realtime.session",
    model: "qwen-audio-3.0-realtime-plus",
    modalities: [...state.modalities],
    voice: state.voice,
    turn_detection: { ...state.turnDetection },
    max_history_turns: state.maxHistoryTurns,
    ...(state.inputAudioFormat === undefined
      ? {}
      : { input_audio_format: state.inputAudioFormat }),
    ...(state.outputAudioFormat === undefined
      ? {}
      : { output_audio_format: state.outputAudioFormat }),
    ...(state.instructions === undefined
      ? {}
      : { instructions: state.instructions }),
  };
}

function compileFixtureInstructions() {
  const common = {
    base: QWEN_LIVE_TEACHING_EXACT_FIXTURES.neutralBase.text,
    safety: TEACHING_SPIKE_FIXTURES.safety.text,
    maxCharacters: 12_000,
  };
  return {
    stateA: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateA.text,
    }).instructions,
    stateB: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateB.text,
    }).instructions,
    stateC: compileTeachingInstructions({
      ...common,
      directive: QWEN_LIVE_TEACHING_EXACT_FIXTURES.stateC.text,
    }).instructions,
  };
}

function successfulResponseTexts(): string[][] {
  return [
    [QWEN_LIVE_TEACHING_EXACT_MARKERS.A, QWEN_LIVE_TEACHING_EXACT_MARKERS.C],
    [QWEN_LIVE_TEACHING_EXACT_MARKERS.B],
  ];
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function singleResponseUsage() {
  return multipliedUsage(1);
}

function multipliedUsage(multiplier: number) {
  return {
    totalTokens: 16 * multiplier,
    inputTokens: 10 * multiplier,
    outputTokens: 6 * multiplier,
    inputTextTokens: 10 * multiplier,
    inputAudioTokens: 0,
    outputTextTokens: 6 * multiplier,
    outputAudioTokens: 0,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a fake-upstream object.");
  }
  return value as Record<string, unknown>;
}

function testTimeouts() {
  return {
    socketOpenMs: 1_000,
    socketCloseMs: 1_000,
    sessionCreatedMs: 1_000,
    updateAckMs: 1_000,
    itemCreatedMs: 1_000,
    responseCreatedMs: 1_000,
    responseDoneMs: 1_000,
  };
}

async function runAndCaptureError(
  fake: Awaited<ReturnType<typeof startFakeUpstream>>,
  timeoutOverrides: Partial<QwenTeachingLiveTimeouts> = {},
): Promise<QwenTeachingLiveAdapterError> {
  return await captureAdapterError(() =>
    runAndCaptureResult(fake, timeoutOverrides),
  );
}

async function captureAdapterError(
  operation: () => Promise<unknown>,
): Promise<QwenTeachingLiveAdapterError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof QwenTeachingLiveAdapterError) return error;
    throw error;
  }
  throw new Error("Expected the live adapter to fail closed.");
}

async function runAndCaptureResult(
  fake: Awaited<ReturnType<typeof startFakeUpstream>>,
  timeoutOverrides: Partial<QwenTeachingLiveTimeouts> = {},
) {
  return await runQwenTeachingTextProtocolSmoke({
    endpoint: "realtime.example.com",
    apiKey: "test-only-key",
    model: "qwen-audio-3.0-realtime-plus",
    voice: "longanqian",
    webSocketFactory: (_url, options) => fake.createClient(options),
    timeouts: { ...testTimeouts(), ...timeoutOverrides },
  });
}
