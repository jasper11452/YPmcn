# WeCom Send Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce approval before `send_wx_messages.py`, schedule one reminder after success, and block autonomous continuation until the user sends a new message.

**Architecture:** Extend the existing OpenClaw runtime entry without adding files or dependencies. A small parser recognizes the exact script invocation and `--remind-at`; hook-owned maps correlate the approved tool call, scheduled Cron job, and waiting session.

**Tech Stack:** TypeScript, OpenClaw Plugin SDK hooks, Node test runner.

## Global Constraints

- Match only `exec`/`bash`/`shell` invocations of `send_wx_messages.py`.
- Require a future ISO 8601 `--remind-at` value.
- Approval allows only `allow-once` or `deny`; timeout denies.
- A successful send creates one one-shot Cron `agentTurn` in the originating session.
- No later tool call may run until `message_received` observes a new user message for that session.
- No new dependency and no unrelated refactor.
- The workspace has no Git repository, so commit steps are intentionally omitted.

---

### Task 1: Approval, scheduling, and wait-state hooks

**Files:**
- Modify: `YPmcn/src/index.ts`
- Test: `YPmcn/tests/hooks.test.mjs`

**Interfaces:**
- Consumes: OpenClaw `before_tool_call`, `after_tool_call`, `message_received`, and `gateway_start` hook payloads.
- Produces: `parseWecomSendInvocation(toolName, params)` and the registered approval/scheduling/wait-state behavior.

- [ ] **Step 1: Add failing tests**

Add tests that register a fake Cron service, then assert:

```js
const cronJobs = [];
await registeredHandler("gateway_start")(
  { port: 18789 },
  { getCron: () => ({ add: async (job) => (cronJobs.push(job), { id: `job-${cronJobs.length}` }) }) },
);

const approval = await registeredHandler("before_tool_call")(
  {
    toolName: "exec",
    toolCallId: "wx-send-1",
    params: { command: "uv run send_wx_messages.py --remind-at 2099-07-06T18:00:00+08:00" },
  },
  { sessionKey: "wx-session-1", agentId: "main" },
);
assert.deepEqual(approval.requireApproval.allowedDecisions, ["allow-once", "deny"]);
assert.equal(approval.requireApproval.timeoutBehavior, "deny");

await approval.requireApproval.onResolution("allow-once");
await registeredHandler("after_tool_call")(
  {
    toolName: "exec",
    toolCallId: "wx-send-1",
    params: { command: "uv run send_wx_messages.py --remind-at 2099-07-06T18:00:00+08:00" },
    result: { exitCode: 0 },
  },
  { sessionKey: "wx-session-1", agentId: "main" },
);
assert.equal(cronJobs.length, 1);
assert.equal(cronJobs[0].payload.kind, "agentTurn");
assert.equal(cronJobs[0].deleteAfterRun, true);
```

Also assert invalid/missing `--remind-at` blocks, `echo send_wx_messages.py` does not match, failure creates no job, duplicate results create one job, waiting blocks tools, and `message_received` unlocks only its own session.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd YPmcn && npm test`

Expected: FAIL because `gateway_start`/`message_received` are not registered and the script receives no approval.

- [ ] **Step 3: Implement the minimal hooks**

In `src/index.ts`:

```ts
const WECOM_SCRIPT = "send_wx_messages.py";
const EXEC_TOOL_NAMES = new Set(["exec", "bash", "shell"]);

interface WecomSendInvocation {
  command: string;
  remindAt: string;
  remindAtMs: number;
}

interface PendingWecomSend extends WecomSendInvocation {
  toolCallId: string;
  sessionKey: string;
  agentId?: string;
}
```

Implement strict command and ISO timestamp parsing. In `before_tool_call`, first block sessions already waiting; otherwise validate the script call, Cron availability, `sessionKey`, `toolCallId`, and future reminder time, then return `requireApproval` with deny-on-timeout and an `onResolution` cleanup callback.

In `after_tool_call`, accept only an approved matching call with no hook error and zero/absent exit code. Set waiting state before awaiting Cron, call `cron.add` with:

```ts
{
  name: `ypmcn-wecom-reminder-${toolCallId}`,
  enabled: true,
  schedule: { kind: "at", at: remindAt },
  sessionTarget: `session:${sessionKey}`,
  payload: {
    kind: "agentTurn",
    message: "企微跟进提醒已到时间。只向用户发送提醒并立即停止，等待用户明确指示；不得调用任何工具或执行下一步。",
  },
  deleteAfterRun: true,
  wakeMode: "now",
  delivery: { mode: "announce", channel: "last" },
}
```

Store completed `toolCallId` values for idempotency. Capture Cron from `gateway_start`; clear only the matching session wait state in `message_received`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd YPmcn && npm test`

Expected: all Node hook tests pass.

### Task 2: Runtime guidance and package regression

**Files:**
- Modify: `YPmcn/skills/media-assistant/SKILL.md`
- Modify: `YPmcn/skills/media-assistant/references/hook-behavior.md`
- Modify: `YPmcn/skills/media-assistant/references/workflow-state-machine.md`
- Modify: `YPmcn/README.md`
- Test: `tests/test_skill_package.py`

**Interfaces:**
- Consumes: hook behavior implemented in Task 1.
- Produces: the runtime-facing command contract and operator documentation.

- [ ] **Step 1: Add package regression assertions**

Add assertions that the packaged guidance contains `send_wx_messages.py`, `--remind-at`, `allow-once`, and the rule that no next step runs until a new user message.

- [ ] **Step 2: Run package tests and verify RED**

Run: `uv run python -m unittest tests/test_skill_package.py`

Expected: FAIL because the new hook contract is not documented.

- [ ] **Step 3: Update guidance**

Document the exact four-stage chain: approval, successful script execution, one-shot reminder creation, and hard wait until `message_received`. State that script failure does not schedule, invalid reminder time blocks before send, and Cron failure preserves the wait lock.

- [ ] **Step 4: Run full verification**

Run:

```bash
cd YPmcn && npm test
cd .. && uv run python -m unittest tests/test_skill_package.py
```

Expected: both commands exit 0 with no failures.
