import * as core from "@actions/core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import * as action from "./action.ts";
import * as api from "./api.ts";
import * as awaitRemoteRun from "./await-remote-run.ts";
import { main } from "./main.ts";
import { mockLoggingFunctions } from "./test-utils/logging.mock.ts";
import { WorkflowRunConclusion, WorkflowRunStatus } from "./types.ts";

vi.mock("@actions/core");
vi.mock("./action.ts");
vi.mock("./api.ts");
vi.mock("./await-remote-run.ts");

describe("main", () => {
  const {
    coreDebugLogMock,
    coreErrorLogMock,
    coreInfoLogMock,
    assertOnlyCalled,
    assertNoneCalled,
  } = mockLoggingFunctions();
  const testCfg: action.ActionConfig = {
    token: "secret",
    repo: "repository",
    owner: "owner",
    runId: 123456,
    runTimeoutSeconds: 300,
    pollIntervalMs: 2500,
  };

  // Core
  let coreSetFailedMock: MockInstance<typeof core.setFailed>;

  // Action
  let actionGetConfigMock: MockInstance<typeof action.getConfig>;

  // API
  let apiFetchWorkflowRunActiveJobUrlRetry: MockInstance<
    typeof api.fetchWorkflowRunActiveJobUrlRetry
  >;
  let apiInitMock: MockInstance<typeof api.init>;

  // Await Remote Run
  let awaitRemoteRunHandleActionFail: MockInstance<
    typeof awaitRemoteRun.handleActionFail
  >;
  let awaitRemoteRunGetWorkflowRunResult: MockInstance<
    typeof awaitRemoteRun.getWorkflowRunResult
  >;

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.useFakeTimers();

    coreSetFailedMock = vi.spyOn(core, "setFailed");

    actionGetConfigMock = vi
      .spyOn(action, "getConfig")
      .mockReturnValue(testCfg);

    apiFetchWorkflowRunActiveJobUrlRetry = vi.spyOn(
      api,
      "fetchWorkflowRunActiveJobUrlRetry",
    );
    apiInitMock = vi.spyOn(api, "init");

    awaitRemoteRunHandleActionFail = vi.spyOn(
      awaitRemoteRun,
      "handleActionFail",
    );
    awaitRemoteRunGetWorkflowRunResult = vi.spyOn(
      awaitRemoteRun,
      "getWorkflowRunResult",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("should successfully complete", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Success,
      },
    });

    await main();

    // Behaviour
    // Setup
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledWith(testCfg);

    // Active Job URL
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledWith(
      testCfg.runId,
      1000,
    );

    // Run Result
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledWith({
      startTime: Date.now(),
      pollIntervalMs: testCfg.pollIntervalMs,
      runId: testCfg.runId,
      runTimeoutMs: testCfg.runTimeoutSeconds * 1000,
    });

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledTimes(2);
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: test-url"
    `);
    expect(coreInfoLogMock.mock.calls[1]?.[0]).toMatchInlineSnapshot(`
      "Run Completed:
        Run ID: 123456
        Status: completed
        Conclusion: success"
    `);
  });

  it("should fail if the active job URL cannot be fetched", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: false,
      reason: "timeout",
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();

    // Run result should not be fetched once the URL fetch fails
    expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "Timeout exceeded while attempting to find the active job run URL (0ms)",
      testCfg.runId,
    );

    // Logging - no info logs since we return before logging the URL
    assertNoneCalled();
  });

  it("should fail if awaiting the run result times out", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: false,
      reason: "timeout",
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();
    expect(apiInitMock).toHaveBeenCalledOnce();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).toHaveBeenCalledOnce();
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "Timeout exceeded while attempting to await run conclusion (0ms)",
      testCfg.runId,
    );

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledOnce();
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: test-url"
    `);
  });

  it("should fail if awaiting the run result returns unsupported", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: false,
      reason: "unsupported",
      value: "weird-value",
    });

    await main();

    // Behaviour
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "An unsupported value was reached: weird-value",
      testCfg.runId,
    );

    // Logging
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledOnce();
  });

  it("should fail if the run has a non-success conclusion", async () => {
    apiFetchWorkflowRunActiveJobUrlRetry.mockResolvedValue({
      success: true,
      value: "test-url",
    });
    awaitRemoteRunGetWorkflowRunResult.mockResolvedValue({
      success: true,
      value: {
        status: WorkflowRunStatus.Completed,
        conclusion: WorkflowRunConclusion.Failure,
      },
    });

    await main();

    // Behaviour
    expect(awaitRemoteRunGetWorkflowRunResult).toHaveBeenCalledOnce();

    // Result
    expect(coreSetFailedMock).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledOnce();
    expect(awaitRemoteRunHandleActionFail).toHaveBeenCalledWith(
      "Run has concluded with failure",
      testCfg.runId,
    );

    // Logging - only the "Awaiting completion" info, no "Run Completed"
    assertOnlyCalled(coreInfoLogMock);
    expect(coreInfoLogMock).toHaveBeenCalledOnce();
    expect(coreInfoLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
      "Awaiting completion of Workflow Run 123456...
        ID: 123456
        URL: test-url"
    `);
  });

  it("should fail for an unhandled error", async () => {
    const testError = new Error("test error");
    actionGetConfigMock.mockImplementation(() => {
      throw testError;
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();

    expect(apiInitMock).not.toHaveBeenCalled();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).not.toHaveBeenCalled();
    expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    expect(coreSetFailedMock).toHaveBeenCalledOnce();
    expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unhandled error has occurred: test error"`,
    );

    // Logging
    assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
    expect(coreErrorLogMock).toHaveBeenCalledOnce();
    expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unhandled error has occurred: test error"`,
    );
    expect(coreDebugLogMock).toHaveBeenCalledOnce();
    expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError.stack);
  });

  it("should fail for an unhandled unknown", async () => {
    const testError = "some other error";
    actionGetConfigMock.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw testError;
    });

    await main();

    // Behaviour
    expect(actionGetConfigMock).toHaveBeenCalledOnce();

    expect(apiInitMock).not.toHaveBeenCalled();
    expect(apiFetchWorkflowRunActiveJobUrlRetry).not.toHaveBeenCalled();
    expect(awaitRemoteRunGetWorkflowRunResult).not.toHaveBeenCalled();
    expect(awaitRemoteRunHandleActionFail).not.toHaveBeenCalled();

    expect(coreSetFailedMock).toHaveBeenCalledOnce();
    expect(coreSetFailedMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unknown error has occurred: some other error"`,
    );

    // Logging
    assertOnlyCalled(coreDebugLogMock, coreErrorLogMock);
    expect(coreErrorLogMock).toHaveBeenCalledOnce();
    expect(coreErrorLogMock.mock.calls[0]?.[0]).toMatchInlineSnapshot(
      `"Failed: An unknown error has occurred: some other error"`,
    );
    expect(coreDebugLogMock).toHaveBeenCalledOnce();
    expect(coreDebugLogMock.mock.calls[0]?.[0]).toStrictEqual(testError);
  });
});
