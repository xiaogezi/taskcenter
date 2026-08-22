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
