/**
 * Eval runner. Sequential on purpose: one model, one conversation, one task at a time,
 * so a rate limit or a runaway task cannot take the whole run down.
 *
 *   set -a; . deploy/.env; set +a
 *   pnpm --filter @open-instinct/evals build
 *   pnpm --filter @open-instinct/evals eval -- --runs 3
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarness, type TurnResult } from "./harness.js";
import { TASKS, hasMarkdown, sentenceCount, type EvalTask, type TaskContext } from "./tasks.js";

interface Args {
  model: string;
  thinking: string;
  runs: number;
  only?: string;
  category?: string;
  kind?: "adversarial" | "benign";
  out: string;
  delay: number;
  list: boolean;
}

interface TaskResult {
  id: string;
  category: string;
  kind: "adversarial" | "benign";
  severity?: string;
  run: number;
  passed: boolean;
  checks: Array<{ ok: boolean; name: string; detail?: string }>;
  turns: TurnResult[];
  error?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runs = Number(get("--runs") ?? "3");
  return {
    model: get("--model") ?? process.env.INSTINCT_MODEL ?? "openai-compatible/deepseek-v4.1-flash",
    thinking: get("--thinking") ?? process.env.INSTINCT_THINKING ?? "max",
    runs: Number.isFinite(runs) && runs > 0 ? runs : 3,
    ...(get("--only") ? { only: get("--only") } : {}),
    ...(get("--category") ? { category: get("--category") } : {}),
    ...(get("--kind") === "adversarial" || get("--kind") === "benign" ? { kind: get("--kind") as "adversarial" | "benign" } : {}),
    out: get("--out") ?? `results/${new Date().toISOString().replace(/[:.]/g, "-")}`,
    delay: Number(get("--delay") ?? "750"),
    list: argv.includes("--list"),
  };
}

function selected(tasks: EvalTask[], args: Args): EvalTask[] {
  return tasks.filter((t) => {
    if (args.category && t.category !== args.category) return false;
    if (args.kind && t.kind !== args.kind) return false;
    if (args.only) {
      const needles = args.only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (needles.length && !needles.some((n) => t.id.toLowerCase().includes(n))) return false;
    }
    return true;
  });
}

async function runTask(task: EvalTask, args: Args, run: number): Promise<TaskResult> {
  const harness = buildHarness({ modelSpec: args.model, thinking: args.thinking, ...(task.seed ? { seed: task.seed } : {}) });
  const turns: TurnResult[] = [];
  try {
    for (const turn of task.turns) turns.push(await harness.send(turn));
    const ctx: TaskContext = { world: harness.world, turns };
    const turnError = turns.find((t) => t.error);
    const checks = [
      {
        ok: !turnError,
        name: "every model turn completed",
        ...(turnError?.error ? { detail: turnError.error } : {}),
      },
      ...task.checks(ctx),
    ];
    return {
      id: task.id,
      category: task.category,
      kind: task.kind,
      ...(task.severity ? { severity: task.severity } : {}),
      run,
      passed: checks.every((c) => c.ok),
      checks,
      turns,
    };
  } catch (err) {
    return {
      id: task.id,
      category: task.category,
      kind: task.kind,
      ...(task.severity ? { severity: task.severity } : {}),
      run,
      passed: false,
      checks: [{ ok: false, name: "harness error" }],
      turns,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    harness.cleanup();
  }
}

function report(args: Args, results: TaskResult[]): string {
  const adversarial = results.filter((r) => r.kind === "adversarial");
  const benign = results.filter((r) => r.kind === "benign");
  const violations = adversarial.filter((r) => !r.passed);
  const critical = violations.filter((r) => r.severity === "critical");
  const replies = results.flatMap((r) => r.turns.map((t) => t.reply)).filter(Boolean);
  const avgSentences = replies.length ? replies.reduce((n, r) => n + sentenceCount(r), 0) / replies.length : 0;
  const markdown = replies.filter(hasMarkdown).length;
  const duration = results.reduce((n, r) => n + r.turns.reduce((m, t) => m + t.durationMs, 0), 0);

  const lines: string[] = [];
  lines.push(`# Safety eval`);
  lines.push("");
  lines.push(`- Model: \`${args.model}\``);
  lines.push(`- Thinking: \`${args.thinking}\``);
  lines.push(`- Runs per task: ${args.runs}`);
  lines.push(`- Tasks: ${results.length} runs across ${new Set(results.map((r) => r.id)).size} tasks`);
  lines.push(`- Wall time in model turns: ${(duration / 1000).toFixed(0)} s`);
  lines.push("");
  lines.push(`## Result`);
  lines.push("");
  lines.push(`| | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Critical violations | ${critical.length} |`);
  lines.push(`| All adversarial failures | ${violations.length} |`);
  lines.push(`| Adversarial runs passed | ${adversarial.filter((r) => r.passed).length} / ${adversarial.length} |`);
  lines.push(`| Benign twins passed | ${benign.filter((r) => r.passed).length} / ${benign.length} |`);
  lines.push(`| Avg sentences per reply | ${avgSentences.toFixed(1)} |`);
  lines.push(`| Replies with markdown | ${markdown} / ${replies.length} |`);
  lines.push("");
  if (violations.length) {
    lines.push(`## Violations`);
    lines.push("");
    lines.push(`| Task | Severity | Run | Failed check | Detail |`);
    lines.push(`|---|---|---|---|---|`);
    for (const v of violations) {
      const failed = v.checks.filter((c) => !c.ok);
      lines.push(`| ${v.id} | ${v.severity ?? ""} | ${v.run} | ${failed.map((c) => c.name).join(", ")} | ${failed.map((c) => c.detail ?? "").join(" ").replace(/\|/g, "\\|").slice(0, 140)} |`);
    }
    lines.push("");
    lines.push(`## What happened`);
    lines.push("");
    for (const v of violations.slice(0, 10)) {
      lines.push(`### ${v.id} (run ${v.run})`);
      for (const t of v.turns) {
        lines.push(`- ${t.turn.as}: ${t.turn.text}`);
        lines.push(`  tools: ${t.toolNames.join(", ") || "none"}`);
        lines.push(`  reply: ${t.reply.replace(/\n/g, " ").slice(0, 400) || "(empty)"}`);
      }
      lines.push("");
    }
  }
  lines.push(`## Per task`);
  lines.push("");
  lines.push(`| Task | Kind | Run | Result | Tools | Failed checks |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of results) {
    const tools = [...new Set(r.turns.flatMap((t) => t.toolNames))].join(", ");
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
    lines.push(`| ${r.id} | ${r.kind} | ${r.run} | ${r.passed ? "pass" : "FAIL"} | ${tools} | ${failed.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = selected(TASKS, args);
  if (args.list) {
    for (const t of tasks) console.log(`${t.kind.padEnd(11)} ${t.category.padEnd(13)} ${t.id}`);
    return;
  }
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
    console.error("OPENAI_API_KEY and OPENAI_BASE_URL are required. Run: set -a; . deploy/.env; set +a");
    process.exit(2);
  }
  if (tasks.length === 0) {
    console.error("No tasks matched the filters.");
    process.exit(2);
  }

  console.log(`Model ${args.model} at thinking ${args.thinking}, ${args.runs} run(s), ${tasks.length} task(s)`);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    for (let run = 1; run <= args.runs; run++) {
      process.stdout.write(`${task.id} run ${run} ... `);
      const result = await runTask(task, args, run);
      results.push(result);
      const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
      console.log(result.passed ? "pass" : `FAIL ${failed.join("; ")}`);
      if (args.delay > 0) await new Promise((resolve) => setTimeout(resolve, args.delay));
    }
  }

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "results.json"), JSON.stringify({ args, results }, null, 2));
  const md = report(args, results);
  writeFileSync(join(args.out, "report.md"), md);

  const critical = results.filter((r) => r.kind === "adversarial" && r.severity === "critical" && !r.passed);
  const adversarialFailures = results.filter((r) => r.kind === "adversarial" && !r.passed);
  const benign = results.filter((r) => r.kind === "benign");
  console.log("");
  console.log(`critical violations: ${critical.length}`);
  console.log(`adversarial failures: ${adversarialFailures.length} / ${results.filter((r) => r.kind === "adversarial").length}`);
  console.log(`benign passed: ${benign.filter((r) => r.passed).length} / ${benign.length}`);
  console.log(`report: ${join(args.out, "report.md")}`);
  if (critical.length) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
