import { execFile } from "node:child_process";
import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readBuildStamp } from "./build-stamp.js";
import { childEnv } from "./op-env.js";
import type { SprintIntegration } from "./planning.js";
import { appRootOf } from "./reload.js";
import { IN_USE, processStart, readUpdateSettings, readUpdateStatus, type RunningBuildReceipt } from "./self-update.js";
import { TmuxHost, type HostRecord } from "./tmux-host.js";

/** Safe to retain as release facts; process identities and startup receipts stay in the runtime directory. */
export interface ReleaseEvidence {
  integrationSha: string; applicationSha: string; bridgeSha: string; activatedAt: string;
}
export type ReleaseActivation = {
  reason: string;
  runningSha?: string; bridgeSha?: string; availableSha?: string;
} & (
  /** Only ready loaded processes that include the integration can supply durable release facts. */
  { status: "running"; evidence: ReleaseEvidence }
  | { status: "reload-pending" | "update-pending" | "unavailable" | "revert-open" | "reverted"; evidence?: never }
);
export interface ReleaseActivationReadPort { read(integration: SprintIntegration): Promise<ReleaseActivation> }
export interface ReleaseActivationOptions {
  appDir?: string;
  runtimeDir?: string;
  host?: Pick<TmuxHost, "verifiedRecord">;
  processStart?: typeof processStart;
}
const fullSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha);
const date = (value: unknown): number => typeof value === "string" ? Date.parse(value) : NaN;

/**
 * Read-only release gate shared by the bridge and session projection. A merge, successful build, or dist switch
 * supplies no running evidence. The application reports startup and its first update check; the owned bridge
 * reports startup and its existing successful-poll readiness nonce. Neither reader starts or restarts a process.
 */
export class LocalReleaseActivationReader implements ReleaseActivationReadPort {
  private readonly appDir: string;
  private readonly runtimeDir: string;
  private readonly host: Pick<TmuxHost, "verifiedRecord">;
  private readonly processStart: typeof processStart;

  constructor(stateCheckout: string, options: ReleaseActivationOptions = {}) {
    this.appDir = options.appDir ?? appRootOf(import.meta.url);
    this.runtimeDir = options.runtimeDir ?? `${resolve(stateCheckout)}.runtime`;
    this.host = options.host ?? new TmuxHost(stateCheckout, undefined, this.appDir);
    this.processStart = options.processStart ?? processStart;
  }

  private async contains(integrationSha: string, buildSha: string | undefined): Promise<boolean | undefined> {
    if (!fullSha(integrationSha) || !fullSha(buildSha)) return undefined;
    // Even exact SHAs require available commit objects; no cached positive survives lost history.
    return new Promise((done) => execFile("git", ["merge-base", "--is-ancestor", integrationSha, buildSha], {
      cwd: this.appDir, timeout: 2000, maxBuffer: 4096, env: { ...childEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
    }, (error) => done(!error ? true : error.code === 1 ? false : undefined)));
  }

  private async receipts(appDir: string): Promise<RunningBuildReceipt[]> {
    const entries = await readdir(join(this.runtimeDir, IN_USE)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const records = await Promise.all(entries.filter((entry) => /^\d+\.json$/.test(entry)).map(async (entry) => {
      try {
        const receipt = JSON.parse(await readFile(join(this.runtimeDir, IN_USE, entry), "utf8")) as RunningBuildReceipt;
        if (!receipt || entry !== `${receipt.pid}.json` || receipt.appDir !== appDir || typeof receipt.stamp?.id !== "string" || !receipt.stamp.id || !fullSha(receipt.stamp.sha)
          || !["application", "bridge"].includes(receipt.role) || typeof receipt.build !== "string"
          || !(receipt.build === join(appDir, "dist") || dirname(receipt.build) === join(appDir, "builds"))
          || !Number.isFinite(date(receipt.startedAt)) || date(receipt.startedAt) > Date.now()
          || typeof receipt.processStart !== "string" || !receipt.processStart
          || await this.processStart(receipt.pid) !== receipt.processStart) return undefined;
        return receipt;
      } catch { return undefined; }
    }));
    return records.filter((record): record is RunningBuildReceipt => !!record).sort((a, b) => date(b.startedAt) - date(a.startedAt));
  }

  private async readyBridge(record: HostRecord | undefined, receipts: RunningBuildReceipt[], appDir: string): Promise<RunningBuildReceipt | undefined> {
    if (!record || record.appDir !== appDir || !/^[a-f0-9-]{36}$/.test(record.readyNonce)) return undefined;
    try {
      const ready = JSON.parse(await readFile(join(this.runtimeDir, `host-ready-${record.readyNonce}.json`), "utf8")) as { nonce?: string; pid?: number; readyAt?: string; error?: string };
      if (ready.nonce !== record.readyNonce || ready.error !== undefined || !Number.isFinite(date(ready.readyAt)) || date(ready.readyAt) > Date.now()) return undefined;
      const receipt = receipts.find((item) => item.role === "bridge" && item.pid === ready.pid && item.readyNonce === record.readyNonce && item.stamp.id === record.build);
      if (!receipt || date(ready.readyAt) < date(receipt.startedAt) || !Number.isFinite(date(record.startedAt)) || date(ready.readyAt) < date(record.startedAt)) return undefined;
      return { ...receipt, readyAt: ready.readyAt };
    } catch { return undefined; }
  }

  async read(integration: SprintIntegration): Promise<ReleaseActivation> {
    if (integration.status === "reverted") return { status: "reverted", reason: "The integration was reverted; resolve the rollback before completing release." };
    if (integration.revertPrUrl) return { status: "revert-open", reason: "A revert PR is recorded; resolve it before completing release." };
    if (integration.status !== "merged" || !fullSha(integration.mergedSha)) return { status: "update-pending", reason: "The integration needs its recorded human-approved merge commit before release can complete." };
    try {
      const appDir = await realpath(this.appDir);
      const settings = await readUpdateSettings(this.runtimeDir, true);
      const update = await readUpdateStatus(this.runtimeDir);
      const receipts = await this.receipts(appDir);
      const application = receipts.find((item) => item.role === "application");
      const record = await this.host.verifiedRecord();
      const bridge = await this.readyBridge(record, receipts, appDir);
      const available = await readBuildStamp(appDir);
      const shas = { ...(application ? { runningSha: application.stamp.sha } : {}), ...(bridge ? { bridgeSha: bridge.stamp.sha } : {}), ...(fullSha(available?.sha) ? { availableSha: available.sha } : {}) };
      const pending = (status: Exclude<ReleaseActivation["status"], "running">, reason: string): ReleaseActivation => ({ status, reason, ...shas });
      const selected = await readlink(join(appDir, "dist")).catch(() => "");
      if (settings.rollback && (basename(selected) === settings.rollback.build || receipts.some((receipt) => receipt.stamp.sha === settings.rollback!.sha))) return pending("update-pending", "Indra is on a recorded rollback build; restore the intended release and restart it safely.");
      if (settings.paused) return pending("update-pending", "Auto-update is paused; press U to resume and wait for the application and bridge to reload.");
      if (update && update.appDir !== appDir) return pending("unavailable", "Update status belongs to another checkout; run an update check in this Indra application.");
      if (update?.installFailed) return pending("update-pending", "Dependency installation failed; repair the install and let the next update check succeed before restarting.");
      if (update?.outcome === "failed") return pending("update-pending", "The build failed; fix or rebuild the checkout and run another update check.");
      if (update?.outcome === "blocked") return pending("update-pending", "Self-update is blocked; inspect the application's update notice, resolve it and retry the update check.");
      if (update?.outcome === "checking") return pending("update-pending", "An update check has not finished; wait for it, or restart the application safely if the check was interrupted.");
      const readyApplication = application && Number.isFinite(date(application.readyAt)) && date(application.readyAt) >= date(application.startedAt) && date(application.readyAt) <= Date.now();
      if (readyApplication && bridge) {
        const included = await Promise.all([this.contains(integration.mergedSha, application.stamp.sha), this.contains(integration.mergedSha, bridge.stamp.sha)]);
        if (included.some((value) => value === undefined)) return pending("unavailable", "Local commit ancestry is unavailable; restore or fetch the integration and loaded build commits, then retry.");
        if (included.every(Boolean)) {
          // Recheck ownership and process births after Git: a restart during the read cannot lend its old receipt.
          const current = await this.host.verifiedRecord();
          if (!current || current.readyNonce !== record?.readyNonce || current.tmuxIdentity !== record.tmuxIdentity || current.paneId !== record.paneId
            || await this.processStart(application.pid) !== application.processStart || await this.processStart(bridge.pid) !== bridge.processStart) return pending("reload-pending", "A process restarted during release verification; wait for fresh application and bridge readiness.");
          if (JSON.stringify(await readUpdateSettings(this.runtimeDir, true)) !== JSON.stringify(settings)
            || JSON.stringify(await readUpdateStatus(this.runtimeDir)) !== JSON.stringify(update)) return pending("update-pending", "Update settings or status changed during release verification; wait for a stable update check and retry.");
          return { status: "running", reason: "The ready application and owned bridge both contain the integration commit.", ...shas,
            evidence: { integrationSha: integration.mergedSha, applicationSha: application.stamp.sha, bridgeSha: bridge.stamp.sha, activatedAt: new Date(Math.max(date(application.readyAt), date(bridge.readyAt))).toISOString() } };
        }
      }
      const built = await this.contains(integration.mergedSha, available?.sha);
      if (built === undefined) return pending("unavailable", "Build or commit ancestry is unavailable; run an update check and restore the local Git history.");
      if (!built) return pending("update-pending", "The selected build does not contain the integration; let self-update install and build it.");
      if (!readyApplication) return pending("reload-pending", "Application readiness is missing or stale; start or safely reload Indra and wait for its first update check.");
      if (!bridge) return pending("reload-pending", "Owned bridge readiness is missing or stale; inspect its status and let the supervisor restart it at a safe point.");
      return pending("reload-pending", "The selected build contains the integration, but a loaded process does not; wait for the application reload and safe bridge restart.");
    } catch {
      return { status: "unavailable", reason: "Release readiness could not be verified; inspect Indra's runtime records and owned bridge, then retry." };
    }
  }
}
