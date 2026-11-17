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
  for (const stage of stages) {
    await runStage(stage);
    await assertOriginalService(original, stage);
  }
  await assertCleanRevision(revision, readRevision, readStatus);
}

export async function assertCleanRevision(expectedRevision, readRevision, readStatus) {
  const [revision, status] = await Promise.all([readRevision(), readStatus()]);
  if (revision !== expectedRevision) {
    throw new Error("部署已阻止：验证期间 Git revision 已变化，请重新执行部署验证。");
  }
  if (status) {
    throw new Error("部署已阻止：工作区存在未提交改动。请完成验证并提交后再部署。");
  }
}

export async function verifyOriginalServiceWithRetries(probe, { attempts = 5, consecutive = 2, delay = () => new Promise(resolve => setTimeout(resolve, 500)) } = {}) {
  let healthyStreak = 0;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probe();
    if (last.identityChanged) {
      throw Object.assign(new Error("original identity changed"), { last, attempt });
    }
    healthyStreak = last.identityMatches && last.healthy ? healthyStreak + 1 : 0;
    if (healthyStreak >= consecutive) return;
    if (attempt < attempts) await delay();
  }
  throw Object.assign(new Error("original service did not pass consecutive health checks"), { last, attempt: attempts });
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
