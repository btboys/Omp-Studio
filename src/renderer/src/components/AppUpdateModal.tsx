import { useEffect, useState } from "react";
import { useStore } from "../store";

/**
 * Startup update prompt. The main process silently checks for a new version
 * and downloads it in the background; when the download lands ("ready" on the
 * pi:appUpdate channel) this modal offers two choices:
 *  - 下次启动更新: defer — install on quit, next launch runs the new version.
 *  - 立即更新:    quit and install now, then relaunch.
 */
export function AppUpdateModal() {
  const language = useStore((s) => s.config?.language || "en");
  const [ready, setReady] = useState<{ version?: string; message: string } | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = window.pi.on.appUpdate((p) => {
      if (p.stage === "ready") setReady({ version: p.version, message: p.message });
    });
    return off;
  }, []);

  if (!ready || (ready.version && dismissedVersion === ready.version)) return null;

  const close = () => {
    setDismissedVersion(ready.version || null);
    setReady(null);
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

  const label = ready.version ? `Omp Studio v${ready.version}` : "Omp Studio";

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-title">{language === "zh" ? "发现新版本" : "Update available"}</div>
        <div className="modal-msg">
          {language === "zh"
            ? `${label} 已下载完成，可以随时安装。`
            : `${label} has been downloaded and is ready to install.`}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={defer} disabled={busy}>
            {language === "zh" ? "下次启动更新" : "Install on next launch"}
          </button>
          <button className="btn primary" onClick={installNow} disabled={busy}>
            {language === "zh" ? "立即更新" : "Restart & update now"}
          </button>
        </div>
      </div>
    </div>
  );
}
