import { useMemo, useState } from "react";
import { MetricsIcon as ChartNoAxesCombined } from "../../components/TaskIcons";
import { FOCUS, Select } from "../../components/ui";
import { isoDate } from "../../lib/dates";
import type { Task } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { useNow } from "../calendar/TimeGrid";
import { taskMetrics } from "./metrics";

const AI_KEY = "task-master.metrics-ai-tag";
const panel = "rounded-xl border border-line bg-raised p-5";
const percent = (part: number, total: number) =>
  total ? `${Math.round((part / total) * 100)}%` : "—";

export function MetricsPage() {
  const tasks = useStoreState((s) => s.tasks);
  const statuses = useStoreState((s) => s.statuses);
  const projects = useStoreState((s) => s.projects);
  const tags = useStoreState((s) => s.tags);
  const today = isoDate(new Date(useNow()));
  const [days, setDays] = useState("30");
  const [project, setProject] = useState("");
  const [tag, setTag] = useState("");
  const [aiChoice, setAiChoice] = useState<string>(() => {
    try {
      return localStorage.getItem(AI_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const aiTag = tags[aiChoice] ? aiChoice : "";
  const projectOptions = Object.values(projects).sort((a, b) => a.name.localeCompare(b.name));
  const tagOptions = Object.values(tags).sort((a, b) => a.name.localeCompare(b.name));
  const filtered = useMemo(
    () =>
      Object.values(tasks).filter(
        (t) =>
          (!project || (project === "inbox" ? t.project_id === null : t.project_id === project)) &&
          (!tag || t.tag_ids.includes(tag)),
      ),
    [tasks, project, tag],
  );
  const metrics = useMemo(
    () => taskMetrics(filtered, statuses, today, Number(days), aiTag),
    [filtered, statuses, today, days, aiTag],
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
  const cards = [
    ["Created", metrics.created, `${(metrics.created / Number(days)).toFixed(1)} per day`],
    ["Completed", metrics.completed, `${(metrics.completed / Number(days)).toFixed(1)} per day`],
    ["Open now", metrics.open, `${metrics.overdue} overdue · ${metrics.stale} stale`],
    [
      "Completion / creation",
      percent(metrics.completed, metrics.created),
      "Completed ÷ created in this period",
    ],
    [
      "Median time to complete",
      metrics.medianDays === null ? "—" : `${metrics.medianDays.toFixed(1)} days`,
      "From creation to completion",
    ],
    [
      "AI handled completions",
      metrics.aiCompleted === null ? "—" : metrics.aiCompleted,
      aiTag
        ? `${percent(metrics.aiCompleted ?? 0, metrics.completed)} of completions · tagged #${tags[aiTag]?.name}`
        : "Choose an AI tag below",
    ],
  ];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[34px] font-normal tracking-wide">
            <ChartNoAxesCombined size={28} className="text-rubric" />
            Metrics
          </h1>
          <p className="mt-1 text-sm text-ink-3">Task flow, workload, and AI contribution.</p>
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
              value={project}
              onValueChange={setProject}
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(([label, value, detail]) => (
          <div key={label} className={panel}>
            <p className="text-sm text-ink-2">{label}</p>
            <p className="my-2 text-3xl tabular-nums">{value}</p>
            <p className="text-xs text-ink-3">{detail}</p>
          </div>
        ))}
      </div>
      <section className={`${panel} mt-5`} aria-label="Daily task flow">
        <div className="flex flex-wrap justify-between gap-2">
          <h2 className="font-display text-xl">Daily task flow</h2>
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
                </tr>
              </thead>
              <tbody>
                {metrics.trend.map((b) => (
                  <tr key={b.date}>
                    <td>{b.date}</td>
                    <td>{b.created}</td>
                    <td>{b.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section className={`${panel} my-5 flex flex-wrap items-center justify-between gap-4`}>
        <div>
          <h2 className="font-display text-xl">AI attribution</h2>
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
        <Breakdown title="By project" rows={projectRows} />
        <Breakdown title="By tag" rows={tagRows} />
      </div>
      <p className="mt-5 text-xs leading-relaxed text-ink-3">
        Period includes today, using local dates. Includes subtasks; excludes deleted tasks.
        Completions count currently done tasks by their latest completion date, not repeated
        completion events. Open, overdue, and stale counts describe the current workload. Groups use
        current project and tag assignments; tasks with multiple tags appear in each tag. Completion
        / creation can exceed 100% when older tasks are completed.
      </p>
    </div>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: (ReturnType<typeof taskMetrics> & { id: string; name: string })[];
}) {
  const active = rows
    .filter((r) => r.open || r.created || r.completed)
    .sort(
      (a, b) => b.completed - a.completed || b.created - a.created || a.name.localeCompare(b.name),
    );
  return (
    <section className={panel}>
      <h2 className="mb-4 font-display text-xl">{title}</h2>
      {active.length === 0 ? (
        <p className="text-sm text-ink-3">No activity or open tasks.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="pb-3">{title === "By project" ? "Project" : "Tag"}</th>
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
                    {r.name}
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
