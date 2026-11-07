import appIcon from "../../assets/brand/app-icon.svg";
import {
  DoneIcon as CheckCircle2,
  DownloadIcon as Download,
  SpinnerIcon as Loader2,
  RefreshIcon as RefreshCw,
  UndoIcon as RotateCcw,
} from "../../components/TaskIcons";
import { Button } from "../../components/ui";
import { BUILD, useUpdates } from "../../lib/updater";

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Version, build and the update button (Settings → About and updates). */
export function About() {
  const updates = useUpdates();
  const status = updates?.status ?? { kind: "idle" as const };

  return (
    <section className="flex flex-col gap-3 border-b border-line py-6" aria-label="About">
      <h2 className="font-display text-[19px] tracking-wide text-accent">About and updates</h2>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 font-display text-[22px] tracking-wide">
          <img src={appIcon} alt="" width={36} height={36} />
          Task Master
        </span>
        <span className="text-ink" data-testid="app-version">
          Version {BUILD.version}
        </span>
        <span className="font-mono text-[12.5px] text-ink-3" title="Commit and build date">
          build {BUILD.commit} · {BUILD.builtAt}
        </span>
      </div>

      {!updates ? (
        <p className="text-[13.5px] text-ink-3">Updates are available in the desktop app.</p>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-raised/60 p-4">
          {status.kind === "idle" && (
            <Row text="Check GitHub for a newer release.">
              <Button size="sm" onClick={() => void updates.check()}>
                <RefreshCw size={14} /> Check for updates
              </Button>
            </Row>
          )}
          {status.kind === "managed" && (
            <p className="text-[13.5px] text-ink-2">
              This copy is installed by {status.by}. Updates arrive through your package manager,
              not from here.
            </p>
          )}
          {status.kind === "checking" && (
            <Row text="Checking for updates…">
              <Loader2 size={16} className="animate-spin text-ink-3" />
            </Row>
          )}
          {status.kind === "current" && (
            <Row
              text={
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={15} className="text-green-700 dark:text-green-400" />
                  You have the latest version (checked at {time(status.checkedAt)}).
                </span>
              }
            >
              <Button size="sm" onClick={() => void updates.check()}>
                <RefreshCw size={14} /> Check again
              </Button>
            </Row>
          )}
          {status.kind === "available" && (
            <>
              <Row
                text={
                  <strong className="font-semibold">
                    Version {status.update.version} is available.
                  </strong>
                }
              >
                <Button variant="primary" size="sm" onClick={() => void updates.install()}>
                  <Download size={14} /> Download and install
                </Button>
              </Row>
              {status.update.notes && (
                <p className="text-[13.5px] whitespace-pre-line text-ink-2">
                  {status.update.notes}
                </p>
              )}
            </>
          )}
          {status.kind === "installing" && (
            <div className="flex flex-col gap-2">
              <span className="text-[13.5px] text-ink-2">
                Downloading version {status.update.version}
                {status.progress !== null ? ` · ${Math.round(status.progress * 100)}%` : "…"}
              </span>
              <div
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  status.progress !== null ? Math.round(status.progress * 100) : undefined
                }
                className="h-1.5 overflow-hidden rounded-full bg-line-strong"
              >
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.round((status.progress ?? 0.05) * 100)}%` }}
                />
              </div>
            </div>
          )}
          {status.kind === "ready" && (
            <Row text={`Version ${status.update.version} is installed. Restart to use it.`}>
              <Button variant="primary" size="sm" onClick={() => void updates.restart()}>
                <RotateCcw size={14} /> Restart now
              </Button>
            </Row>
          )}
          {status.kind === "error" && (
            <Row
              text={
                <span className="text-danger" role="alert">
                  {status.during === "check" ? "Could not check for updates" : "The update failed"}:{" "}
                  {status.message}
                </span>
              }
            >
              <Button
                size="sm"
                onClick={() =>
                  void (status.during === "install" ? updates.install() : updates.check())
                }
              >
                <RefreshCw size={14} /> Try again
              </Button>
            </Row>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ text, children }: { text: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-[14px] text-ink-2">
      <span className="min-w-0 flex-1">{text}</span>
      {children}
    </div>
  );
}
