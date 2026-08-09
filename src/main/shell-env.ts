import { spawnSync } from "node:child_process";

/**
 * macOS GUI apps inherit launchd's sparse environment, not the user's
 * interactive shell. API keys exported in ~/.zshrc (DEEPSEEK_API_KEY, …)
 * therefore never reach the omp child process: the provider silently falls
 * back to another one and the configured default model "doesn't load".
 * Resolve the login shell's environment once at startup and fill the gaps.
 */
export function mergeShellEnv(): void {
  if (process.platform === "win32") return;
  const shellPath = process.env.SHELL || "/bin/zsh";
  const marker = "__OMP_STUDIO_ENV_MARKER__";
  try {
    const res = spawnSync(shellPath, ["-lic", `echo ${marker}; env`], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    const out = res.stdout || "";
    // Interactive rc files may print arbitrary junk; only parse after the marker.
    const idx = out.lastIndexOf(marker);
    if (idx < 0) return;
    for (const line of out.slice(idx + marker.length).split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const value = line.slice(eq + 1);
      if (key === "PATH") {
        // launchd's PATH is a minimal stub; the shell's is the useful one.
        if (value && value !== process.env.PATH) process.env.PATH = value;
        continue;
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no usable login shell: keep the launchd environment */
  }
}
