import { useEffect, useState } from "react";
import { useStore } from "../store";

interface Notice {
  stage: "ready" | "available";
  version?: string;
  message: string;
  releaseUrl?: string | null;
}

/**
 * Update prompt.
 *  - "ready": the main process downloaded a new Windows build in the
 *    background; offer install-on-next-launch or restart & install now.
 *  - "available": a new release exists but the platform has no in-app
 *    installer (macOS/Linux); link to the GitHub release page instead.
 */
export function AppUpdateModal() {
  const language = useStore((s) => s.config?.language || "en");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = window.pi.on.appUpdate((p) => {
      if (p.stage === "ready") {
        setNotice({ stage: "ready", version: p.version, message: p.message });
      } else if (p.stage === "available") {
        setNotice({
          stage: "available",
          version: p.version,
          message: p.message,
          releaseUrl: p.releaseUrl ?? null,
        });
      }
    });
    return off;
  }, []);

  if (!notice || dismissed === `${notice.stage}:${notice.version || ""}`) return null;

  const close = () => {
    setDismissed(`${notice.stage}:${notice.version || ""}`);
    setNotice(null);
  };

  const defer = async () => {
    setBusy(true);
    try {
      await window.pi.app.deferAppUpdate();
    } finally {
      setBusy(false);
      close();
    }
  };

  const installNow = async () => {
    setBusy(true);
    // quitAndInstall tears the app down; no need to close anything ourselves.
    await window.pi.app.installAppUpdate();
  };

  const openDownloadPage = () => {
    if (notice.releaseUrl) window.open(notice.releaseUrl, "_blank");
    close();
  };

  const label = notice.version ? `Omp Studio v${notice.version}` : "Omp Studio";

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-title">{language === "zh" ? "发现新版本" : "Update available"}</div>
        <div className="modal-msg">
          {notice.stage === "ready"
            ? language === "zh"
              ? `${label} 已下载完成，可以随时安装。`
              : `${label} has been downloaded and is ready to install.`
            : language === "zh"
              ? `${label} 有新版可用。当前平台不支持应用内自动安装，请从 GitHub Releases 手动下载。`
              : `${label} is available. This platform cannot install updates in-app; download it from GitHub Releases.`}
        </div>
        <div className="modal-actions">
          {notice.stage === "ready" ? (
            <>
              <button className="btn" onClick={defer} disabled={busy}>
                {language === "zh" ? "下次启动更新" : "Install on next launch"}
              </button>
              <button className="btn primary" onClick={installNow} disabled={busy}>
                {language === "zh" ? "立即更新" : "Restart & update now"}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {language === "zh" ? "以后再说" : "Later"}
              </button>
              <button className="btn primary" onClick={openDownloadPage}>
                {language === "zh" ? "打开下载页" : "Open download page"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
