"use client";

import { useEffect, useState } from "react";

type HealthRelease = { version?: string; revision?: string };

// 页面版本徽章：读取控制面 /health 的 release 信息，在所有工作台页面右下角展示。
export default function VersionBadge() {
  const [release, setRelease] = useState<HealthRelease | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/control/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setRelease(data?.release || null);
      })
      .catch(() => {
        if (!cancelled) setRelease(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const label = release && (release.version || release.revision)
    ? `TaskCenter v${release.version || "?"}${release.revision ? ` · ${release.revision}` : ""}`
    : "";
  if (!label) return null;
  return <footer className="version-badge">{label}</footer>;
}
