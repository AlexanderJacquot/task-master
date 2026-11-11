import { TrendingDown } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import {
  AddIcon,
  AgentsIcon,
  AllTasksIcon,
  DeleteIcon as BrazierIcon,
  MetricsIcon as ChartNoAxesCombined,
  CloseIcon,
  DoneIcon,
  DueDateIcon,
  InboxIcon,
  ProjectsIcon,
  TagIcon,
  TodayIcon,
} from "../../components/TaskIcons";
import { Button, FOCUS, Select } from "../../components/ui";
import { addDays } from "../../lib/calendar";
import { isoDate } from "../../lib/dates";
import { useIsClean } from "../../lib/theme";
import type { Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { ProjectMark } from "../organize/ProjectMark";
import { TitleCrest, TitleFlourish } from "../ornaments/Ornaments";
import { burnDown, taskMetrics } from "./metrics";

const AI_KEY = "task-master.metrics-ai-tag";
const panel = "rounded-xl border border-line bg-raised p-5";
const percent = (part: number, total: number) =>
  total ? `${Math.round((part / total) * 100)}%` : "—";
/** Open tasks removed per day; negative (with a real minus sign) when the backlog grew. */
function perDay(removed: number) {
  return `${removed < 0 ? "−" : ""}${Math.abs(removed).toFixed(1)} a day`;
}

type Icon = ComponentType<{ size?: number; className?: string }>;

/**
 * The Metrics page. `project` focuses one project ("inbox" for tasks with none, "" for all);
 * it lives in the URL so a project's ⋯ menu can open its stats.
 */
export function MetricsPage({
  project,
  onProject,
}: {
  project: string;
  onProject(id: string): void;
}) {
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const today = isoDate(new Date(useNow()));
  const [days, setDays] = useState("30");
  const [tag, setTag] = useState("");
  const [aiChoice, setAiChoice] = useState<string>(() => {
    try {
      return localStorage.getItem(AI_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const aiTag = tags[aiChoice] ? aiChoice : "";
  const focused = project === "inbox" ? "inbox" : projects[project] ? project : "";
  const projectOptions = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name));
  const tagOptions = Object.values(tags).sort((a, b) => a.name.localeCompare(b.name));
  const filtered = useMemo(
    () =>
      Object.values(tasks).filter(
        (t) =>
          (!focused || (focused === "inbox" ? t.project_id === null : t.project_id === focused)) &&
          (!tag || t.tag_ids.includes(tag)),
      ),
    [tasks, focused, tag],
  );
  const metrics = useMemo(
    () => taskMetrics(filtered, statuses, today, Number(days), aiTag),
    [filtered, statuses, today, days, aiTag],
  );
  const burn = useMemo(
    () => burnDown(filtered, statuses, today, Number(days)),
    [filtered, statuses, today, days],
  );
  const max = Math.max(1, ...metrics.trend.flatMap((b) => [b.created, b.completed]));
  const summarize = (rows: Task[]) => taskMetrics(rows, statuses, today, Number(days), aiTag);
  const projectRows = [
    ...projectOptions.map((p) => ({ id: p.id, name: p.name })),
    { id: "inbox", name: "Inbox" },
  ].map((p) => ({
    id: p.id,
    name: p.name,
    ...summarize(
      filtered.filter((t) => (p.id === "inbox" ? t.project_id === null : t.project_id === p.id)),
    ),
  }));
  const tagRows = [
    ...tagOptions.map((t) => ({ id: t.id, name: `#${t.name}` })),
    { id: "untagged", name: "Untagged" },
  ].map((tag) => ({
    id: tag.id,
    name: tag.name,
    ...summarize(
      filtered.filter((t) =>
        tag.id === "untagged" ? t.tag_ids.length === 0 : t.tag_ids.includes(tag.id),
      ),
    ),
  }));
  // Each figure has a period name and the plain measure it stands for.
  const cards: [Icon, string, string, ReactNode, string][] = [
    [
      AddIcon,
      "Quests taken up",
      "Created",
      metrics.created,
      `${(metrics.created / Number(days)).toFixed(1)} per day`,
    ],
    [
      DoneIcon,
      "Quests fulfilled",
      "Completed",
      metrics.completed,
      `${(metrics.completed / Number(days)).toFixed(1)} per day`,
    ],
    [
      AllTasksIcon,
      "Still afield",
      "Open now",
      metrics.open,
      `${metrics.overdue} overdue · ${metrics.stale} stale`,
    ],
    [
      ChartNoAxesCombined,
      "Scales of the ledger",
      "Completion / creation",
      percent(metrics.completed, metrics.created),
      "Completed ÷ created in this period",
    ],
    [
      DueDateIcon,
      "Days to fulfil",
      "Median time to complete",
      metrics.medianDays === null ? "—" : `${metrics.medianDays.toFixed(1)} days`,
      "From creation to completion",
    ],
    [
      AgentsIcon,
      "The squires' share",
      "AI handled completions",
      metrics.aiCompleted === null ? "—" : metrics.aiCompleted,
      aiTag
        ? `${percent(metrics.aiCompleted ?? 0, metrics.completed)} of completions · tagged #${tags[aiTag]?.name}`
        : "Choose an AI tag below",
    ],
  ];
  const focusedProject = focused && focused !== "inbox" ? projects[focused] : undefined;
  // The clean theme (ADR 021) names each figure by its plain measure, without the chronicle.
  const clean = useIsClean();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[34px] leading-tight font-normal tracking-wide">
            <TitleCrest />
            <ChartNoAxesCombined size={28} className="text-rubric" />
            Metrics
          </h1>
          <TitleFlourish />
          <p className="mt-1 text-sm text-ink-3">
            {clean
              ? "Task flow, workload, and AI contribution."
              : "The ledger of deeds: task flow, workload, and AI contribution."}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="text-xs text-ink-3">
            Period
            <Select
              aria-label="Period"
              value={days}
              onValueChange={setDays}
              options={[7, 30, 90].map((n) => ({ value: String(n), label: `Last ${n} days` }))}
            />
          </div>
          <div className="text-xs text-ink-3">
            Project
            <Select
              aria-label="Project"
              value={focused}
              onValueChange={onProject}
              options={[
                { value: "", label: "All projects" },
                { value: "inbox", label: "Inbox" },
                ...projectOptions.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div className="text-xs text-ink-3">
            Tag
            <Select
              aria-label="Tag"
              value={tag}
              onValueChange={setTag}
              options={[
                { value: "", label: "All tags" },
                ...tagOptions.map((t) => ({ value: t.id, label: `#${t.name}` })),
              ]}
            />
          </div>
        </div>
      </header>
      {focused && (
        <section
          aria-label="Focused project"
          className={`${panel} mb-5 flex flex-wrap items-center justify-between gap-3 border-rubric/40`}
        >
          <div className="flex min-w-0 items-center gap-3">
            {focusedProject ? (
              <ProjectMark project={focusedProject} dotClass="size-3" className="text-[26px]" />
            ) : (
              <InboxIcon size={24} className="text-ink-2" />
            )}
            <div className="min-w-0">
              <p className="text-[11px] tracking-wider text-ink-3 uppercase">
                {clean ? "Project" : "The holding of"}
              </p>
              <h2 className="truncate font-display text-2xl">{focusedProject?.name ?? "Inbox"}</h2>
            </div>
          </div>
          <Button size="sm" onClick={() => onProject("")}>
            <CloseIcon size={14} /> Show all projects
          </Button>
        </section>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(([CardIcon, title, plain, value, detail]) => (
          <div key={plain} className={panel}>
            <div className="flex items-center gap-2">
              <CardIcon size={18} className="shrink-0 text-rubric" />
              <p
                className={
                  clean ? "text-sm font-medium text-ink-2" : "font-display text-lg leading-tight"
                }
              >
                {clean ? plain : title}
              </p>
            </div>
            {!clean && (
              <p className="mt-0.5 text-[11px] tracking-wider text-ink-3 uppercase">{plain}</p>
            )}
            <p className="my-2 font-display text-4xl tabular-nums">{value}</p>
            <p className="text-xs text-ink-3">{detail}</p>
          </div>
        ))}
      </div>
      <BurnDown burn={burn} days={days} today={today} />
      <section className={`${panel} mt-5`} aria-label="Daily task flow">
        <div className="flex flex-wrap justify-between gap-2">
          <SectionTitle icon={TodayIcon} title="Chronicle of days" plain="Daily task flow" />
          <p className="text-xs text-ink-3">
            <span className="text-accent">● Created</span>{" "}
            <span className="ml-3 text-rubric">● Completed</span>
          </p>
        </div>
        {metrics.created + metrics.completed === 0 && (
          <p className="mt-3 text-sm text-ink-3">No tasks created or completed in this period.</p>
        )}
        <div
          className="mt-4 flex h-40 items-end gap-1"
          role="img"
          aria-label={`${metrics.created} created and ${metrics.completed} completed over the last ${days} days. Daily values are available below.`}
        >
          {metrics.trend.map((b) => (
            <div
              key={b.date}
              className="flex h-full min-w-0 flex-1 items-end gap-px"
              title={`${b.date}: ${b.created} created, ${b.completed} completed`}
            >
              <div
                className="min-w-0 flex-1 rounded-t bg-accent"
                style={{ height: `${(b.created / max) * 100}%` }}
              />
              <div
                className="min-w-0 flex-1 rounded-t bg-rubric"
                style={{ height: `${(b.completed / max) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-ink-3">
          <span>{metrics.trend[0]?.date}</span>
          <span>{today}</span>
        </div>
        <details className="mt-4 text-sm">
          <summary className={`cursor-pointer text-ink-2 ${FOCUS}`}>Daily values</summary>
          <div className="mt-3 max-h-64 overflow-auto">
            <table className="w-full text-left tabular-nums">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Created</th>
                  <th>Completed</th>
                  <th>Open at day end</th>
                </tr>
              </thead>
              <tbody>
                {metrics.trend.map((b, i) => (
                  <tr key={b.date}>
                    <td>{b.date}</td>
                    <td>{b.created}</td>
                    <td>{b.completed}</td>
                    <td>{burn.points[i]?.open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section className={`${panel} my-5 flex flex-wrap items-center justify-between gap-4`}>
        <div>
          <SectionTitle icon={AgentsIcon} title="The squires' tally" plain="AI attribution" />
          <p className="mt-1 max-w-2xl text-sm text-ink-3">
            Choose the tag you use for AI handled tasks. AI stats count completed tasks carrying
            that tag; they do not infer who performed the work.
          </p>
        </div>
        <div className="text-xs text-ink-3">
          AI handled tag
          <Select
            aria-label="AI handled tag"
            value={aiTag}
            onValueChange={(value) => {
              setAiChoice(value);
              try {
                localStorage.setItem(AI_KEY, value);
              } catch {
                /* Session only. */
              }
            }}
            options={[
              { value: "", label: "Not tracked" },
              ...tagOptions.map((t) => ({ value: t.id, label: `#${t.name}` })),
            ]}
          />
        </div>
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <Breakdown
          kind="Project"
          icon={ProjectsIcon}
          title="Keeps and holdings"
          rows={projectRows}
          focused={focused}
          onFocus={onProject}
        />
        <Breakdown
          kind="Tag"
          icon={TagIcon}
          title="Banners"
          rows={tagRows.filter((r) => r.id !== "untagged")}
          extra={tagRows.find((r) => r.id === "untagged")}
          focused={tag}
          onFocus={setTag}
        />
      </div>
      <p className="mt-5 text-xs leading-relaxed text-ink-3">
        Period includes today, using local dates. Includes subtasks; excludes deleted tasks.
        Completions count currently done tasks by their latest completion date, not repeated
        completion events. Open, overdue, and stale counts describe the current workload. The
        burn-down rebuilds each day's open count from creation and completion times; a cancelled
        task counts as closed at its last update. Groups use current project and tag assignments;
        tasks with multiple tags appear in each tag. Completion / creation can exceed 100% when
        older tasks are completed.
      </p>
    </div>
  );
}

/** A section's chronicle title over its plain measure. The clean theme shows the measure
 *  alone as the title, or `clean` = [title, subtitle] when the measure is long. */
function SectionTitle({
  icon: SectionIcon,
  title,
  plain,
  clean: cleanText,
}: {
  icon: Icon;
  title: string;
  plain: string;
  clean?: [string, string];
}) {
  const clean = useIsClean();
  const sub = clean ? (cleanText?.[1] ?? null) : plain;
  return (
    <div>
      <h2 className="flex items-center gap-2 font-display text-xl clean:text-[17px]">
        <SectionIcon size={18} className="shrink-0 text-rubric" />
        {clean ? (cleanText?.[0] ?? plain) : title}
      </h2>
      {sub && (
        <p className="text-[11px] tracking-wider text-ink-3 uppercase clean:text-xs clean:tracking-normal clean:normal-case">
          {sub}
        </p>
      )}
    </div>
  );
}

function forecastText(burn: ReturnType<typeof burnDown>, today: string, clean: boolean) {
  const left = burn.clearInDays;
  if (left === 0) return clean ? "Nothing left open." : "Nothing left open: the field is clear.";
  if (left === null) {
    if (clean && burn.netPerDay < 0) return "The backlog is growing at this pace.";
    return burn.netPerDay < 0
      ? "The backlog grows at this pace; no end in sight."
      : "The backlog holds steady at this pace.";
  }
  const span = `${left} ${left === 1 ? "day" : "days"}`;
  return `At this pace the last open task falls in ${span} (${addDays(today, left)}).`;
}

/** Open tasks at each day's end as a line over a soft area, with a hover crosshair. */
function BurnDown({
  burn,
  days,
  today,
}: {
  burn: ReturnType<typeof burnDown>;
  days: string;
  today: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, burn.peak);
  const n = burn.points.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const y = (open: number) => (1 - open / top) * 100;
  const line = burn.points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.open)}`).join(" ");
  const area = `${line} L100,100 L0,100 Z`;
  const point = hover === null ? undefined : burn.points[hover];
  const forecast = forecastText(burn, today, useIsClean());
  const stats: [string, string][] = [
    ["Open at the start", String(burn.before)],
    ["Open now", String(burn.now)],
    ["Net burn rate", perDay(burn.netPerDay)],
  ];
  return (
    <section className={`${panel} mt-5`} aria-label="Burn-down">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionTitle
          icon={useIsClean() ? TrendingDown : BrazierIcon}
          title="The burning of the backlog"
          plain="Burn-down: open tasks at each day's end"
          clean={["Burn-down", "Open tasks at each day's end"]}
        />
        <dl className="flex flex-wrap gap-6 text-right">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-ink-3">{label}</dt>
              <dd className="font-display text-2xl tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-2 text-sm text-ink-2">{forecast}</p>
      <div className="mt-4 flex gap-2">
        <div className="flex h-40 w-6 flex-col justify-between text-right text-xs text-ink-3 tabular-nums">
          <span>{top}</span>
          <span>0</span>
        </div>
        <div
          className="relative h-40 flex-1 border-b border-line"
          role="img"
          aria-label={`Open tasks went from ${burn.before} to ${burn.now} over the last ${days} days, a net burn of ${perDay(burn.netPerDay)}. ${forecast} Daily values are in the task flow table.`}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const at = box.width ? (e.clientX - box.left) / box.width : 0;
            setHover(Math.min(n - 1, Math.max(0, Math.round(at * (n - 1)))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 border-t border-dashed border-line"
          />
          <svg
            aria-hidden
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible text-accent"
          >
            <path d={area} fill="currentColor" opacity={0.14} />
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {point && hover !== null && (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 border-l border-ink-3/60"
                style={{ left: `${x(hover)}%` }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-raised"
                style={{ left: `${x(hover)}%`, top: `${y(point.open)}%` }}
              />
              <div
                className="tm-menu pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-overlay px-2 py-1 text-xs whitespace-nowrap shadow"
                style={
                  x(hover) > 60
                    ? { right: `${100 - x(hover)}%`, marginRight: 8 }
                    : { left: `${x(hover)}%`, marginLeft: 8 }
                }
              >
                <span className="text-ink-3">{point.date}</span>{" "}
                <span className="tabular-nums">{point.open} open</span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 ml-8 flex justify-between text-xs text-ink-3">
        <span>{burn.points[0]?.date}</span>
        <span>{today}</span>
      </div>
    </section>
  );
}

function Breakdown({
  kind,
  icon,
  title,
  rows,
  extra,
  focused,
  onFocus,
}: {
  kind: "Project" | "Tag";
  icon: Icon;
  title: string;
  rows: (ReturnType<typeof taskMetrics> & { id: string; name: string })[];
  /** A last row that cannot be focused (tasks with no tag). */
  extra?: ReturnType<typeof taskMetrics> & { id: string; name: string };
  focused: string;
  onFocus(id: string): void;
}) {
  const busy = (r: ReturnType<typeof taskMetrics>) => r.open || r.created || r.completed;
  const active = [
    ...rows
      .filter(busy)
      .sort(
        (a, b) =>
          b.completed - a.completed || b.created - a.created || a.name.localeCompare(b.name),
      ),
    ...(extra && busy(extra) ? [extra] : []),
  ];
  return (
    <section className={panel} aria-label={`By ${kind.toLowerCase()}`}>
      <div className="mb-4">
        <SectionTitle icon={icon} title={title} plain={`By ${kind.toLowerCase()}`} />
      </div>
      {active.length === 0 ? (
        <p className="text-sm text-ink-3">No activity or open tasks.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="pb-3">{kind}</th>
                {["Created", "Completed", "Open", "AI done", "AI share"].map((s) => (
                  <th key={s} className="pb-3 pl-3 text-right font-normal">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <th scope="row" className="py-3 pr-3 font-normal">
                    {r === extra ? (
                      r.name
                    ) : (
                      <button
                        type="button"
                        aria-pressed={focused === r.id}
                        title={focused === r.id ? "Show all again" : `Focus on ${r.name}`}
                        onClick={() => onFocus(focused === r.id ? "" : r.id)}
                        className={`rounded text-left underline-offset-4 hover:text-rubric hover:underline aria-pressed:text-rubric ${FOCUS}`}
                      >
                        {r.name}
                      </button>
                    )}
                  </th>
                  {[
                    r.created,
                    r.completed,
                    r.open,
                    r.aiCompleted ?? "—",
                    r.aiCompleted === null ? "—" : percent(r.aiCompleted, r.completed),
                  ].map((value, i) => (
                    <td
                      key={["created", "completed", "open", "ai", "share"][i]}
                      className="py-3 pl-3 text-right"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
