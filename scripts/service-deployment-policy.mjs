export async function verifyBeforeServiceCutover(options) {
  const {
    original,
    revision,
    stages,
    runStage,
    assertOriginalService,
    readRevision,
    readStatus,
  } = options;

  await assertCleanRevision(revision, readRevision, readStatus);
  await assertOriginalService(original, "preflight");
  for (const stage of stages) {
    try {
      await runStage(stage);
    } catch (error) {
      error.code ||= "TASKCENTER_RELEASE_STAGE_FAILED";
      error.stage = stage;
      throw error;
    }
    await assertOriginalService(original, stage);
  }
  await assertCleanRevision(revision, readRevision, readStatus);
}

export async function assertCleanRevision(expectedRevision, readRevision, readStatus) {
  const [revision, status] = await Promise.all([readRevision(), readStatus()]);
  if (revision !== expectedRevision) {
    throw Object.assign(new Error("部署已阻止：验证期间 Git revision 已变化，请重新执行部署验证。"), { code: "TASKCENTER_RELEASE_REVISION_CHANGED" });
  }
  if (status) {
    throw Object.assign(new Error("部署已阻止：工作区存在未提交改动。请完成验证并提交后再部署。"), { code: "TASKCENTER_RELEASE_DIRTY_WORKTREE" });
  }
}

export async function verifyOriginalServiceWithRetries(probe, { attempts = 5, consecutive = 2, delay = () => new Promise(resolve => setTimeout(resolve, 500)) } = {}) {
  let healthyStreak = 0;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probe();
    if (last.identityChanged) {
      throw Object.assign(new Error("original identity changed"), { code: "TASKCENTER_RELEASE_IDENTITY_CHANGED", last, attempt });
    }
    healthyStreak = last.identityMatches && last.healthy ? healthyStreak + 1 : 0;
    if (healthyStreak >= consecutive) return;
    if (attempt < attempts) await delay();
  }
  throw Object.assign(new Error("original service did not pass consecutive health checks"), { code: "TASKCENTER_RELEASE_UNHEALTHY", last, attempt: attempts });
}

export async function cutoverWithRollback(options) {
  const {
    stopOriginal,
    startCandidate,
    assertCandidateHealthy,
    restoreOriginal,
  } = options;

  await stopOriginal();
  try {
    await startCandidate();
    await assertCandidateHealthy();
    return { outcome: "succeeded", rollback: false };
  } catch (releaseError) {
    try {
      await restoreOriginal();
    } catch (rollbackError) {
      throw new AggregateError(
        [releaseError, rollbackError],
        `新版本启动失败且旧版本恢复失败：${releaseError.message}; ${rollbackError.message}`,
      );
    }
    const error = new Error(`新版本启动失败，已恢复上一版本：${releaseError.message}`, { cause: releaseError });
    error.code = "TASKCENTER_RELEASE_ROLLED_BACK";
    throw error;
  }
}

// Machine-readable evidence plus an actionable retry prerequisite; never retries
// or relaxes deployment checks, and never serializes the original service token.
export function deploymentFailureDetails(error) {
  const code = error.code || "TASKCENTER_RELEASE_FAILED";
  const actions = {
    TASKCENTER_RELEASE_IDENTITY_CHANGED: "先核对原服务由谁重启、当前 PID 与发布记录；确认当前实例身份和健康后再重试，不要盲目重复构建。",
    TASKCENTER_RELEASE_UNHEALTHY: "先恢复并确认当前实例持续健康，再重新部署。",
    TASKCENTER_RELEASE_DIRTY_WORKTREE: "先完成验证并提交工作区改动，再重新部署。",
    TASKCENTER_RELEASE_REVISION_CHANGED: "先确认目标提交稳定，再从完整验证开始重新部署。",
    TASKCENTER_RELEASE_STAGE_FAILED: "先修复失败阶段并核对输出，再重新执行完整部署验证。",
  };
  return { failureCode: code, failedStage: error.stage || null,
    retryAction: actions[code] || "先核对失败记录与当前服务状态，再决定是否重试。" };
}


export function assertExpectedServiceIdentity(expected, current, stage = "cutover") {
  if (!expected?.pid || !expected?.token || current?.pid !== expected.pid || current?.token !== expected.token) {
    throw Object.assign(new Error("部署已中止：停止目标不再是已验证的原实例，未停止替换进程。"), {
      code: "TASKCENTER_RELEASE_IDENTITY_CHANGED", stage,
    });
  }
  return current;
}


export async function restoreOwnedCandidate({ candidate, readCurrent, stopCandidate, assertVacant, restore }) {
  const current = readCurrent();
  if (current) {
    assertExpectedServiceIdentity(candidate, current, "rollback");
    await stopCandidate(candidate);
  }
  // A failed launch may leave an intent, live process tree or an occupied port
  // without a usable state file. None is permission to stop an unknown process.
  await assertVacant(candidate);
  await restore();
}


// A receipt-bound candidate may have exited before its supervisor heartbeat was
// observed. Clear only its stale runtime after proving there are no occupants,
// then re-read identity immediately before cleanup (no await in that interval).
export async function clearExitedOwnedCandidate({ expected, readCurrent, hasOccupants, clear }) {
  assertExpectedServiceIdentity(expected, readCurrent(), "exited candidate cleanup");
  if (await hasOccupants(expected)) return false;
  assertExpectedServiceIdentity(expected, readCurrent(), "exited candidate cleanup");
  clear();
  return true;
}
