// Kimi 0.43 returns session_<UUID>. Preserve the native ID for ACP;
// use its existing UUID component for TaskCenter/PCA, never generate a replacement.
export function kimiTaskcenterSessionId(nativeId) {
  const id = typeof nativeId === "string" ? nativeId.replace(/^session_/, "") : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Kimi returned a non-UUID Session; no identity mapping was fabricated");
  return id.toLowerCase();
}
