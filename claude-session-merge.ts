#!/usr/bin/env bun
/**
 * claude-session-merge — merge Claude desktop-app session metadata across accounts (macOS only).
 *
 * Storage model (BASE = ~/Library/Application Support/Claude):
 *   Two parallel "session-tree" dirs hold desktop session POINTER/index files (not transcripts):
 *     - claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json
 *     - local-agent-mode-sessions/<accountUuid>/<orgUuid>/{local_<id>.json | local_<id>/ dir | spaces.json}
 *   <accountUuid> is the active account (== lastKnownAccountUuid in BASE/config.json); <orgUuid> is its org.
 *   Each local_<id>.json references the REAL transcript via cliSessionId under ~/.claude — NEVER touched here.
 *
 * Concept — canonical merge, then optional link:
 *   A "location" = an <account>/<org> pair (present in one or both trees). MERGE (Step A, non-destructive)
 *   unions the pointer files/dirs from SOURCE locations INTO a CANONICAL location across both trees, and
 *   unions spaces.json by id (canonical wins). LINK (Step B, destructive, opt-in) backs up each source org
 *   dir and replaces it with a symlink to canonical so those accounts stay synchronized. Copy goes INTO
 *   canonical; symlinks point every other location AT canonical — never copy into a location you then link away.
 *
 * Safety: dry-run is the default (nothing changes without --apply). This tool never reads/writes ~/.claude,
 *   .jsonl transcripts, or the leveldb store (leveldb is scanned read-only, best-effort, only to REPORT pins).
 *   Backups are made before any destructive op; canonical files are never overwritten silently.
 *
 * Revert: LINK is reversible. `--revert` scans for the `*.bak-<stamp>` dirs LINK left behind, drops each
 *   symlink, and moves the newest backup back into place — restoring the pre-symlink state. It only ever
 *   removes a symlink; a real directory sitting at the original path is treated as a conflict and skipped.
 *
 * Logging: every run is mirrored (ANSI stripped) to <scriptDir>/logs/session-merge-<ts>.log. Disable with
 *   --no-log, or redirect with --log-file=<path>.
 *
 * Usage:
 *   bun claude-session-merge.ts                         # fully interactive, dry-run
 *   bun claude-session-merge.ts --canonical=A/O --sources=B/O,C/O          # dry-run plan (no prompts)
 *   bun claude-session-merge.ts --canonical=A/O --all-others --apply        # apply MERGE only
 *   bun claude-session-merge.ts --canonical=A/O --all-others --link --apply --yes  # apply MERGE + LINK
 *   bun claude-session-merge.ts --revert                                    # dry-run: show what LINK would undo
 *   bun claude-session-merge.ts --revert --apply                           # restore pre-symlink backups
 *
 * Flags: --apply --canonical=<a>/<o> --sources=<a>/<o>[,...] --all-others --link --revert
 *        --log-file=<path> --no-log --yes --help
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// --- ANSI color (disabled when not a TTY or NO_COLOR set) -------------------
const useColor = process.env.NO_COLOR == null && stdout.isTTY === true;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  cyan: paint("36"),
};

// --- file logging: tee all stdout/stderr to a log file ----------------------
// Every run is mirrored (ANSI stripped) to <scriptDir>/logs/session-merge-<ts>.log
// unless --no-log is passed. Override the destination with --log-file=<path>.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
let logFd: number | null = null;
let logFilePath: string | null = null;

function scriptDir(): string {
  const meta = import.meta as unknown as { dir?: string; url: string };
  if (typeof meta.dir === "string") return meta.dir;
  return path.dirname(new URL(meta.url).pathname);
}

function writeLogRaw(line: string): void {
  if (logFd == null) return;
  try {
    fs.writeSync(logFd, line);
  } catch {
    // logging must never break the run
  }
}

function initLogging(explicitPath: string | undefined, argv: string[]): void {
  try {
    const target = explicitPath
      ? path.resolve(explicitPath)
      : path.join(scriptDir(), "logs", `session-merge-${timestamp()}.log`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    logFd = fs.openSync(target, "a");
    logFilePath = target;

    const patch =
      (orig: (chunk: any, ...rest: any[]) => boolean) =>
      function (chunk: any, ...rest: any[]): boolean {
        try {
          if (logFd != null) {
            const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            fs.writeSync(logFd, s.replace(ANSI_RE, ""));
          }
        } catch {
          // ignore file write failures — the terminal write below still happens
        }
        return orig(chunk, ...rest);
      };
    process.stdout.write = patch(process.stdout.write.bind(process.stdout)) as typeof process.stdout.write;
    process.stderr.write = patch(process.stderr.write.bind(process.stderr)) as typeof process.stderr.write;

    writeLogRaw(`\n===== claude-session-merge @ ${new Date().toISOString()} =====\n`);
    writeLogRaw(`argv: ${argv.length ? argv.join(" ") : "(none)"}\n\n`);
  } catch (err) {
    process.stderr.write(c.yellow(`warning: file logging disabled (${(err as Error).message})\n`));
    logFd = null;
    logFilePath = null;
  }
}

function closeLogging(): void {
  if (logFd == null) return;
  writeLogRaw(`\n===== end @ ${new Date().toISOString()} =====\n`);
  try {
    fs.closeSync(logFd);
  } catch {
    // ignore
  }
  logFd = null;
}

const TREES = ["claude-code-sessions", "local-agent-mode-sessions"] as const;
const SESSION_FILE_RE = /^local_.*\.json$/;

// --- small fs helpers -------------------------------------------------------
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name))))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function fail(msg: string): never {
  process.stderr.write(c.red(`error: ${msg}`) + "\n");
  process.exit(1);
}

// --- types ------------------------------------------------------------------
interface Location {
  account: string;
  org: string;
  key: string; // `${account}/${org}`
}
interface Args {
  apply: boolean;
  link: boolean;
  revert: boolean;
  yes: boolean;
  help: boolean;
  allOthers: boolean;
  noLog: boolean;
  canonical?: string;
  sources?: string[];
  logFile?: string;
}
interface CopyItem {
  tree: string;
  name: string;
  kind: "file" | "dir";
  src: string;
  dest: string;
}
interface Conflict {
  tree: string;
  name: string;
  kind: "file" | "dir";
  reason: "differs" | "dir-exists";
}
interface SourcePlan {
  source: Location;
  copies: CopyItem[];
  conflicts: Conflict[];
  identical: number;
  spacesAdded: any[];
}
interface SpacesMerge {
  canonPath: string;
  before: number;
  merged: any[];
  added: number;
  willWrite: boolean;
}
interface LinkPlan {
  tree: string;
  source: Location;
  srcDir: string;
  canonDir: string;
  backupDir: string;
  alreadySymlink: boolean;
}
interface Plan {
  canonical: Location;
  sourcePlans: SourcePlan[];
  spacesMerge: SpacesMerge | null;
  linkPlans: LinkPlan[];
  sessionIds: Set<string>;
  spaceIds: Set<string>;
}

// --- CLI parsing ------------------------------------------------------------
function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false, link: false, revert: false, yes: false, help: false, allOthers: false, noLog: false };
  for (const raw of argv) {
    if (raw === "--apply") a.apply = true;
    else if (raw === "--link") a.link = true;
    else if (raw === "--revert") a.revert = true;
    else if (raw === "--yes" || raw === "-y") a.yes = true;
    else if (raw === "--help" || raw === "-h") a.help = true;
    else if (raw === "--all-others") a.allOthers = true;
    else if (raw === "--no-log") a.noLog = true;
    else if (raw.startsWith("--log-file=")) a.logFile = raw.slice("--log-file=".length).trim();
    else if (raw.startsWith("--canonical=")) a.canonical = raw.slice("--canonical=".length).trim();
    else if (raw.startsWith("--sources=")) {
      a.sources = raw
        .slice("--sources=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else fail(`unknown argument: ${raw} (use --help)`);
  }
  return a;
}

function printHelp(): void {
  const b = c.bold;
  process.stdout.write(
    `${b("claude-session-merge")} — merge Claude desktop session metadata across accounts (macOS only)

${b("USAGE")}
  bun claude-session-merge.ts [flags]

${b("FLAGS")}
  --canonical=<acct>/<org>   Target location that receives the merged sessions.
  --sources=<a>/<o>[,...]    One or more source locations to merge FROM.
  --all-others               Use every non-canonical location as a source.
  --link                     Also do Step B: back up each source org dir and symlink it to canonical.
  --revert                   Undo a previous --link: restore each *.bak-<ts> backup over its symlink.
  --apply                    Execute changes. Without this flag the tool is a DRY RUN (nothing changes).
  --yes, -y                  Skip the confirmation prompt on --apply.
  --log-file=<path>          Write the run log here (default: <script-dir>/logs/session-merge-<ts>.log).
  --no-log                   Disable file logging for this run.
  --help, -h                 Show this help.

${b("CONCEPT")}
  A "location" is an <account>/<org> pair under the two session trees. MERGE (non-destructive) copies
  pointer files/dirs from sources INTO canonical across both trees and unions spaces.json by id
  (canonical wins). LINK (destructive, opt-in) replaces each source org dir with a symlink to canonical.
  REVERT undoes LINK by restoring the *.bak-<ts> backups it left behind. Every run is logged to a file.

${b("EXAMPLES")}
  bun claude-session-merge.ts                                              # interactive, dry-run
  bun claude-session-merge.ts --canonical=A/O --sources=B/O                # dry-run plan
  bun claude-session-merge.ts --canonical=A/O --all-others --apply         # apply MERGE only
  bun claude-session-merge.ts --canonical=A/O --all-others --link --apply  # apply MERGE + LINK
  bun claude-session-merge.ts --revert                                     # dry-run: preview the undo
  bun claude-session-merge.ts --revert --apply                            # restore pre-symlink backups
`
  );
}

// --- discovery --------------------------------------------------------------
function discoverLocations(base: string): Location[] {
  const map = new Map<string, Location>();
  for (const tree of TREES) {
    const treeDir = path.join(base, tree);
    if (!isDir(treeDir)) continue;
    for (const account of listDirs(treeDir)) {
      for (const org of listDirs(path.join(treeDir, account))) {
        const key = `${account}/${org}`;
        if (!map.has(key)) map.set(key, { account, org, key });
      }
    }
  }
  return [...map.values()].sort((x, y) => x.key.localeCompare(y.key));
}

function orgDir(base: string, tree: string, loc: Location): string {
  return path.join(base, tree, loc.account, loc.org);
}

interface OrgEntries {
  files: string[]; // local_*.json (top-level, excludes spaces.json)
  dirs: string[]; // any subdirectory
}
function readOrgEntries(dir: string): OrgEntries {
  const out: OrgEntries = { files: [], dirs: [] };
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (d.name === "spaces.json") continue; // merged separately
    const full = path.join(dir, d.name);
    const entryIsDir = d.isDirectory() || (d.isSymbolicLink() && isDir(full));
    if (entryIsDir) out.dirs.push(d.name);
    else if (d.isFile() && SESSION_FILE_RE.test(d.name)) out.files.push(d.name);
    // other files (scheduled-tasks.json, .DS_Store, caches, ...) are intentionally ignored
  }
  out.files.sort();
  out.dirs.sort();
  return out;
}

interface LocationSummary {
  total: number;
  recentTitles: string[];
}
function summarizeLocation(base: string, loc: Location): LocationSummary {
  const byId = new Map<string, { title: string; lastActivityAt: number }>();
  for (const tree of TREES) {
    const dir = orgDir(base, tree, loc);
    const { files } = readOrgEntries(dir);
    for (const name of files) {
      const id = name.replace(/\.json$/, "");
      if (byId.has(id)) continue;
      const idx = readJson(path.join(dir, name));
      const title = (idx && typeof idx.title === "string" && idx.title) || id;
      const lastActivityAt = (idx && Number(idx.lastActivityAt)) || 0;
      byId.set(id, { title, lastActivityAt });
    }
  }
  const recentTitles = [...byId.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, 3)
    .map((s) => s.title);
  return { total: byId.size, recentTitles };
}

function readSpaces(spacesPath: string): any[] {
  const data = readJson(spacesPath);
  if (data && Array.isArray(data.spaces)) return data.spaces;
  return [];
}

// --- planning (pure reads, no mutations) ------------------------------------
function buildSourcePlan(base: string, canon: Location, source: Location): SourcePlan {
  const plan: SourcePlan = { source, copies: [], conflicts: [], identical: 0, spacesAdded: [] };
  for (const tree of TREES) {
    const srcDir = orgDir(base, tree, source);
    const canonDir = orgDir(base, tree, canon);
    if (!isDir(srcDir)) continue;
    const srcEntries = readOrgEntries(srcDir);
    const candidates: Array<{ name: string; kind: "file" | "dir" }> = [
      ...srcEntries.files.map((name) => ({ name, kind: "file" as const })),
      ...srcEntries.dirs.map((name) => ({ name, kind: "dir" as const })),
    ];
    for (const { name, kind } of candidates) {
      const src = path.join(srcDir, name);
      const dest = path.join(canonDir, name);
      if (!exists(dest)) {
        plan.copies.push({ tree, name, kind, src, dest });
        continue;
      }
      if (kind === "dir") {
        plan.conflicts.push({ tree, name, kind, reason: "dir-exists" });
        continue;
      }
      let differs = true;
      try {
        differs = Buffer.compare(fs.readFileSync(src), fs.readFileSync(dest)) !== 0;
      } catch {
        differs = true;
      }
      if (differs) plan.conflicts.push({ tree, name, kind, reason: "differs" });
      else plan.identical += 1;
    }
  }
  return plan;
}

function collectSessionIds(entries: OrgEntries): string[] {
  return [
    ...entries.files.map((n) => n.replace(/\.json$/, "")),
    ...entries.dirs.filter((n) => n.startsWith("local_")),
  ];
}

function buildPlan(base: string, canon: Location, sources: Location[], linkMode: boolean): Plan {
  const sessionIds = new Set<string>();
  const spaceIds = new Set<string>();
  const sourcePlans = sources.map((s) => buildSourcePlan(base, canon, s));

  // session ids that end up in canonical (existing canonical + everything from sources)
  for (const tree of TREES) {
    for (const id of collectSessionIds(readOrgEntries(orgDir(base, tree, canon)))) sessionIds.add(id);
    for (const s of sources)
      for (const id of collectSessionIds(readOrgEntries(orgDir(base, tree, s)))) sessionIds.add(id);
  }

  // spaces.json merge (agent-mode tree only), canonical wins on id collision
  const agentTree = "local-agent-mode-sessions";
  const canonSpacesPath = path.join(orgDir(base, agentTree, canon), "spaces.json");
  const merged = new Map<string, any>();
  for (const sp of readSpaces(canonSpacesPath)) if (sp && sp.id) merged.set(sp.id, sp);
  const before = merged.size;
  const sourcePlanBySource = new Map(sourcePlans.map((sp) => [sp.source.key, sp]));
  for (const s of sources) {
    const added: any[] = [];
    for (const sp of readSpaces(path.join(orgDir(base, agentTree, s), "spaces.json"))) {
      if (sp && sp.id && !merged.has(sp.id)) {
        merged.set(sp.id, sp);
        added.push(sp);
      }
    }
    const sourcePlan = sourcePlanBySource.get(s.key);
    if (sourcePlan) sourcePlan.spacesAdded = added;
  }
  const mergedArr = [...merged.values()];
  for (const sp of mergedArr) if (sp && sp.id) spaceIds.add(sp.id);
  const added = mergedArr.length - before;
  const spacesMerge: SpacesMerge | null =
    mergedArr.length === 0
      ? null
      : {
          canonPath: canonSpacesPath,
          before,
          merged: mergedArr,
          added,
          willWrite: added > 0 || !exists(canonSpacesPath),
        };

  // link plans (destructive)
  const linkPlans: LinkPlan[] = [];
  if (linkMode) {
    const stamp = timestamp();
    for (const s of sources) {
      for (const tree of TREES) {
        const srcDir = orgDir(base, tree, s);
        if (!exists(srcDir)) continue; // nothing to link in this tree
        linkPlans.push({
          tree,
          source: s,
          srcDir,
          canonDir: orgDir(base, tree, canon),
          backupDir: `${srcDir}.bak-${stamp}`,
          alreadySymlink: isSymlink(srcDir),
        });
      }
    }
  }

  return { canonical: canon, sourcePlans, spacesMerge, linkPlans, sessionIds, spaceIds };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// --- plan rendering ---------------------------------------------------------
function shorten(key: string): string {
  return key; // kept full; helper reserved for future truncation
}
function listCapped(items: string[], cap = 20): string[] {
  if (items.length <= cap) return items;
  return [...items.slice(0, cap), c.dim(`... and ${items.length - cap} more`)];
}

function printPlan(plan: Plan, linkMode: boolean): void {
  const out = process.stdout;
  out.write("\n" + c.bold("PLAN") + "\n");
  out.write(`  Canonical: ${c.cyan(plan.canonical.key)}\n`);

  let totalCopyFiles = 0;
  let totalCopyDirs = 0;
  let totalConflicts = 0;

  for (const sp of plan.sourcePlans) {
    out.write(`\n  ${c.bold("Source")} ${c.blue(sp.source.key)}\n`);
    if (sp.source.key === plan.canonical.key) {
      out.write(`    ${c.dim("(same as canonical — skipped)")}\n`);
      continue;
    }
    for (const tree of TREES) {
      const copies = sp.copies.filter((x) => x.tree === tree);
      const conflicts = sp.conflicts.filter((x) => x.tree === tree);
      if (copies.length === 0 && conflicts.length === 0) {
        out.write(`    [${tree}] ${c.dim("nothing to copy")}\n`);
        continue;
      }
      const files = copies.filter((x) => x.kind === "file");
      const dirs = copies.filter((x) => x.kind === "dir");
      totalCopyFiles += files.length;
      totalCopyDirs += dirs.length;
      totalConflicts += conflicts.length;
      out.write(
        `    [${tree}] copy ${c.green(String(files.length))} files, ${c.green(String(dirs.length))} dirs; ` +
          `${conflicts.length ? c.yellow(String(conflicts.length)) : "0"} conflicts (kept canonical)\n`
      );
      for (const line of listCapped(files.map((x) => `      + ${x.name}`))) out.write(line + "\n");
      for (const line of listCapped(dirs.map((x) => `      + ${x.name}/  (dir)`))) out.write(line + "\n");
      for (const x of conflicts.slice(0, 20)) {
        const why = x.reason === "differs" ? "differs" : "dir exists";
        out.write(`      ${c.yellow("!")} ${x.name}${x.kind === "dir" ? "/" : ""}  (${why}, kept canonical)\n`);
      }
    }
    if (sp.identical > 0) out.write(`    ${c.dim(`(${sp.identical} identical file(s) skipped)`)}\n`);
    if (sp.spacesAdded.length > 0)
      out.write(`    spaces.json: ${c.green("+" + sp.spacesAdded.length)} new space(s)\n`);
  }

  if (plan.spacesMerge) {
    const m = plan.spacesMerge;
    out.write(
      `\n  ${c.bold("spaces.json (canonical)")}: ${m.before} existing, ${c.green("+" + m.added)} added, ` +
        `${m.merged.length} total${m.willWrite ? "" : c.dim(" (no write needed)")}\n`
    );
  }

  if (linkMode) {
    out.write("\n" + c.red(c.bold("  LINK (DESTRUCTIVE) — Step B")) + "\n");
    out.write(
      c.yellow("  ⚠  QUIT the Claude desktop app before applying LINK, or it may recreate/overwrite these dirs.\n")
    );
    if (plan.linkPlans.length === 0) out.write(`    ${c.dim("no source org dirs to link")}\n`);
    for (const lp of plan.linkPlans) {
      if (lp.alreadySymlink) {
        out.write(`    [${lp.tree}] ${c.dim(`${lp.srcDir} is already a symlink — skipped`)}\n`);
        continue;
      }
      out.write(`    [${lp.tree}] ${c.blue(lp.source.key)}\n`);
      out.write(`        backup:  ${lp.srcDir}\n`);
      out.write(`             ->  ${lp.backupDir}\n`);
      out.write(`        symlink: ${lp.srcDir} -> ${c.cyan(lp.canonDir)}\n`);
    }
  }

  out.write(
    `\n  ${c.bold("Totals")}: ${totalCopyFiles} file(s) + ${totalCopyDirs} dir(s) to copy, ` +
      `${totalConflicts} conflict(s) kept, ${plan.spacesMerge ? plan.spacesMerge.added : 0} space(s) added` +
      (linkMode ? `, ${plan.linkPlans.filter((l) => !l.alreadySymlink).length} dir(s) to symlink` : "") +
      "\n"
  );
}

// --- execution (only reached with --apply) ----------------------------------
interface ExecResult {
  copiedFiles: number;
  copiedDirs: number;
  spacesWritten: boolean;
  linked: number;
  backedUp: number;
  errors: string[];
}
function executePlan(plan: Plan, linkMode: boolean): ExecResult {
  const r: ExecResult = { copiedFiles: 0, copiedDirs: 0, spacesWritten: false, linked: 0, backedUp: 0, errors: [] };

  // Step A: merge copies INTO canonical
  for (const sp of plan.sourcePlans) {
    if (sp.source.key === plan.canonical.key) continue;
    for (const item of sp.copies) {
      try {
        fs.mkdirSync(path.dirname(item.dest), { recursive: true });
        if (item.kind === "dir") {
          fs.cpSync(item.src, item.dest, { recursive: true });
          r.copiedDirs += 1;
        } else {
          fs.copyFileSync(item.src, item.dest);
          r.copiedFiles += 1;
        }
      } catch (err) {
        r.errors.push(`copy ${item.src} -> ${item.dest}: ${(err as Error).message}`);
      }
    }
  }

  // spaces.json merge write
  if (plan.spacesMerge && plan.spacesMerge.willWrite) {
    try {
      fs.mkdirSync(path.dirname(plan.spacesMerge.canonPath), { recursive: true });
      fs.writeFileSync(plan.spacesMerge.canonPath, JSON.stringify({ spaces: plan.spacesMerge.merged }, null, 2));
      r.spacesWritten = true;
    } catch (err) {
      r.errors.push(`write ${plan.spacesMerge.canonPath}: ${(err as Error).message}`);
    }
  }

  // Step B: back up source org dirs and symlink to canonical
  if (linkMode) {
    for (const lp of plan.linkPlans) {
      if (lp.alreadySymlink) continue;
      try {
        fs.mkdirSync(lp.canonDir, { recursive: true }); // ensure symlink target exists
        fs.renameSync(lp.srcDir, lp.backupDir);
        r.backedUp += 1;
        fs.symlinkSync(lp.canonDir, lp.srcDir);
        r.linked += 1;
      } catch (err) {
        r.errors.push(`link ${lp.srcDir}: ${(err as Error).message}`);
      }
    }
  }

  return r;
}

// --- read-only leveldb pin/group report -------------------------------------
function levelDbReport(base: string, plan: Plan): void {
  const out = process.stdout;
  out.write("\n" + c.bold("LevelDB pin/group report") + c.dim(" (read-only, best-effort)") + "\n");
  const dbDir = path.join(base, "Local Storage", "leveldb");
  try {
    if (!isDir(dbDir)) {
      out.write(`  ${c.dim("no leveldb store found — skipping")}\n`);
      return;
    }
    const files = fs
      .readdirSync(dbDir)
      .filter((n) => n.endsWith(".ldb") || n.endsWith(".log"))
      .map((n) => path.join(dbDir, n));
    const needles = [...plan.sessionIds, ...plan.spaceIds];
    const found = new Set<string>();
    for (const file of files) {
      let hay: string;
      try {
        hay = fs.readFileSync(file).toString("latin1");
      } catch {
        continue;
      }
      for (const id of needles) if (!found.has(id) && hay.includes(id)) found.add(id);
    }
    if (needles.length === 0) {
      out.write(`  ${c.dim("no session/space ids in scope")}\n`);
      return;
    }
    out.write(
      `  ${found.size}/${needles.length} merged id(s) are referenced by leveldb (pins/groups/stars/sort).\n`
    );
    for (const id of [...found].slice(0, 15)) out.write(`    ${c.cyan("•")} ${id}\n`);
    if (found.size > 15) out.write(`    ${c.dim(`... and ${found.size - 15} more`)}\n`);
    out.write(
      c.dim(
        "  Note: leveldb is a single global store shared app-wide; it is NEVER modified by this tool.\n" +
          "  Pins/groups reference sessions by id, so they follow the merged sessions automatically.\n"
      )
    );
  } catch (err) {
    out.write(`  ${c.yellow("leveldb scan failed:")} ${(err as Error).message}\n`);
  }
}

// --- interactive selection --------------------------------------------------
function requireTty(what: string): void {
  if (stdin.isTTY !== true)
    fail(`${what} requires an interactive terminal. Pass it via flags instead (see --help).`);
}

function matchLocation(key: string, locations: Location[]): Location {
  const found = locations.find((l) => l.key === key);
  if (!found) fail(`location not found: ${key} (must be one of the discovered <account>/<org> pairs)`);
  return found;
}

async function pickCanonical(
  rl: readline.Interface,
  locations: Location[]
): Promise<Location> {
  while (true) {
    const ans = (await rl.question(c.bold("\nChoose CANONICAL location (number): "))).trim();
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= locations.length) return locations[n - 1];
    process.stdout.write(c.yellow(`  enter a number between 1 and ${locations.length}\n`));
  }
}

async function pickSources(
  rl: readline.Interface,
  locations: Location[],
  canonical: Location
): Promise<Location[]> {
  const others = locations.filter((l) => l.key !== canonical.key);
  if (others.length === 0) return [];
  while (true) {
    const ans = (
      await rl.question(
        c.bold("Choose SOURCE location(s) — comma-separated numbers, or 'a' for all others: ")
      )
    ).trim();
    if (ans.toLowerCase() === "a") return others;
    const nums = ans.split(",").map((s) => Number(s.trim()));
    const valid = nums.every((n) => Number.isInteger(n) && n >= 1 && n <= locations.length);
    if (valid && nums.length > 0) {
      const picked = [...new Set(nums)]
        .map((n) => locations[n - 1])
        .filter((l) => l.key !== canonical.key);
      if (picked.length > 0) return picked;
    }
    process.stdout.write(c.yellow("  enter valid numbers (not the canonical), or 'a'\n"));
  }
}

async function pickLinkMode(rl: readline.Interface): Promise<boolean> {
  while (true) {
    const ans = (
      await rl.question(c.bold("\n1) MERGE only   2) MERGE then LINK (destructive) — choose [1/2]: "))
    ).trim();
    if (ans === "1") return false;
    if (ans === "2") return true;
    process.stdout.write(c.yellow("  enter 1 or 2\n"));
  }
}

async function confirm(rl: readline.Interface, message: string): Promise<boolean> {
  const ans = (await rl.question(c.bold(message + " Type 'yes' to proceed: "))).trim();
  return ans.toLowerCase() === "yes";
}

// --- revert (undo Step B / --link) ------------------------------------------
// LINK backs up each source org dir to `<org>.bak-<stamp>` then replaces the org dir
// with a symlink to canonical. REVERT reverses that: drop the symlink and move the
// newest backup back into place. It only ever removes a SYMLINK — a real directory at
// the original path is treated as a conflict and left untouched.
interface BackupEntry {
  tree: string;
  account: string;
  originalName: string;
  stamp: string;
  backupDir: string;
  originalDir: string;
  currentExists: boolean;
  currentIsSymlink: boolean;
  currentIsRealDir: boolean;
  symlinkTarget: string | null;
}

function readLinkSafe(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

const BACKUP_RE = /^(.*)\.bak-(.+)$/;

function discoverBackups(base: string): BackupEntry[] {
  const out: BackupEntry[] = [];
  for (const tree of TREES) {
    const treeDir = path.join(base, tree);
    if (!isDir(treeDir)) continue;
    for (const account of listDirs(treeDir)) {
      const accDir = path.join(treeDir, account);
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(accDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        const m = d.name.match(BACKUP_RE);
        if (!m) continue;
        const backupDir = path.join(accDir, d.name);
        if (!isDir(backupDir)) continue; // only our directory backups
        const originalDir = path.join(accDir, m[1]);
        const currentExists = exists(originalDir);
        const currentIsSymlink = isSymlink(originalDir);
        out.push({
          tree,
          account,
          originalName: m[1],
          stamp: m[2],
          backupDir,
          originalDir,
          currentExists,
          currentIsSymlink,
          currentIsRealDir: currentExists && !currentIsSymlink && isDir(originalDir),
          symlinkTarget: currentIsSymlink ? readLinkSafe(originalDir) : null,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.tree.localeCompare(b.tree) ||
      a.account.localeCompare(b.account) ||
      a.originalName.localeCompare(b.originalName) ||
      a.stamp.localeCompare(b.stamp)
  );
}

interface RevertItem {
  chosen: BackupEntry;
  older: BackupEntry[]; // additional, older backups left in place
  action: "restore" | "conflict";
  reason?: string;
}

function buildRevertItems(backups: BackupEntry[]): RevertItem[] {
  // group by tree/account/originalName; newest stamp wins (ISO stamps sort lexically)
  const groups = new Map<string, BackupEntry[]>();
  for (const b of backups) {
    const key = `${b.tree} ${b.account} ${b.originalName}`;
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  const items: RevertItem[] = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => b.stamp.localeCompare(a.stamp)); // newest first
    const [chosen, ...older] = arr;
    let action: "restore" | "conflict" = "restore";
    let reason: string | undefined;
    if (chosen.currentIsRealDir) {
      action = "conflict";
      reason = "a real directory (not a symlink) sits at the original path";
    } else if (chosen.currentExists && !chosen.currentIsSymlink) {
      action = "conflict";
      reason = "an unexpected non-directory entry sits at the original path";
    }
    items.push({ chosen, older, action, reason });
  }
  return items.sort(
    (a, b) =>
      a.chosen.tree.localeCompare(b.chosen.tree) ||
      a.chosen.account.localeCompare(b.chosen.account) ||
      a.chosen.originalName.localeCompare(b.chosen.originalName)
  );
}

function printRevertPlan(items: RevertItem[]): void {
  const out = process.stdout;
  out.write("\n" + c.bold("REVERT PLAN") + c.dim(" (undo --link)") + "\n");
  if (items.length === 0) {
    out.write(`  ${c.dim("no *.bak-<stamp> backups found — nothing to revert.")}\n`);
    return;
  }
  let restores = 0;
  let conflicts = 0;
  for (const it of items) {
    const b = it.chosen;
    const loc = `${b.account}/${b.originalName}`;
    if (it.action === "conflict") {
      conflicts += 1;
      out.write(`    [${b.tree}] ${c.yellow("!")} ${c.blue(loc)}  ${c.yellow("(skipped: " + it.reason + ")")}\n`);
    } else {
      restores += 1;
      const cur = b.currentIsSymlink
        ? `symlink -> ${b.symlinkTarget ?? "?"}`
        : b.currentExists
          ? "existing entry"
          : c.dim("(nothing there)");
      out.write(`    [${b.tree}] ${c.green("↺")} ${c.blue(loc)}\n`);
      out.write(`        current: ${cur}\n`);
      out.write(`        restore: ${c.cyan(b.backupDir)}\n`);
      out.write(`             ->  ${b.originalDir}\n`);
    }
    if (it.older.length > 0)
      out.write(`        ${c.dim(`(${it.older.length} older backup(s) left in place)`)}\n`);
  }
  out.write(
    `\n  ${c.bold("Totals")}: ${c.green(String(restores))} to restore, ` +
      `${conflicts ? c.yellow(String(conflicts)) : "0"} conflict(s) skipped\n`
  );
}

interface RevertResult {
  restored: number;
  removedSymlinks: number;
  errors: string[];
}

function executeRevert(items: RevertItem[]): RevertResult {
  const r: RevertResult = { restored: 0, removedSymlinks: 0, errors: [] };
  for (const it of items) {
    if (it.action !== "restore") continue;
    const b = it.chosen;
    try {
      if (b.currentIsSymlink) {
        fs.unlinkSync(b.originalDir);
        r.removedSymlinks += 1;
      }
      if (exists(b.originalDir)) {
        r.errors.push(`restore ${b.originalDir}: path still exists after clearing symlink — skipped`);
        continue;
      }
      fs.renameSync(b.backupDir, b.originalDir);
      r.restored += 1;
    } catch (err) {
      r.errors.push(`restore ${b.backupDir} -> ${b.originalDir}: ${(err as Error).message}`);
    }
  }
  return r;
}

async function runRevert(base: string, args: Args): Promise<void> {
  process.stdout.write(c.bold("claude-session-merge") + c.dim(" — revert (macOS)") + "\n");
  process.stdout.write(`BASE: ${c.cyan(base)}\n`);

  const items = buildRevertItems(discoverBackups(base));
  printRevertPlan(items);

  const restorable = items.filter((it) => it.action === "restore");

  if (!args.apply) {
    process.stdout.write("\n" + c.bold(c.yellow("DRY RUN — no filesystem changes were made.")) + "\n");
    if (restorable.length > 0)
      process.stdout.write(c.dim("Re-run with --revert --apply to restore the backups above.\n"));
    return;
  }

  if (restorable.length === 0) {
    process.stdout.write("\n" + c.green("Nothing to restore — done.") + "\n");
    return;
  }

  process.stdout.write(
    "\n" + c.yellow("⚠  QUIT the Claude desktop app before reverting, or it may recreate the symlinked dirs.\n")
  );

  if (!args.yes) {
    requireTty("Confirmation");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const ok = await confirm(rl, "Proceed with REVERT (restore pre-symlink backups)?");
      if (!ok) {
        process.stdout.write(c.yellow("Aborted — no changes made.\n"));
        return;
      }
    } finally {
      rl.close();
    }
  }

  const result = executeRevert(items);
  process.stdout.write("\n" + c.bold("SUMMARY") + "\n");
  process.stdout.write(
    `  Restored: ${c.green(String(result.restored))} dir(s) (${result.removedSymlinks} symlink(s) removed)\n`
  );
  if (result.errors.length) {
    process.stdout.write(c.red(`  ${result.errors.length} error(s):\n`));
    for (const e of result.errors) process.stdout.write(c.red(`    - ${e}\n`));
  }
  process.stdout.write(
    "\n" + c.cyan("Reopen the Claude desktop app to confirm each account shows its own sessions again.") + "\n"
  );
}

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (process.platform !== "darwin")
    fail(`this tool is macOS-only (detected platform: ${process.platform}).`);

  const base = path.join(os.homedir(), "Library/Application Support/Claude");
  if (!isDir(base))
    fail(`Claude desktop data dir not found at:\n  ${base}\nIs the Claude desktop app installed for this user?`);

  if (!args.noLog) {
    initLogging(args.logFile, process.argv.slice(2));
    if (logFilePath) process.stdout.write(c.dim(`Logging to: ${logFilePath}`) + "\n");
  }

  if (args.revert) {
    try {
      await runRevert(base, args);
    } finally {
      closeLogging();
    }
    return;
  }

  const config = readJson(path.join(base, "config.json")) || {};
  const activeAccount: string | undefined = config.lastKnownAccountUuid;

  process.stdout.write(c.bold("claude-session-merge") + c.dim(" (macOS)") + "\n");
  process.stdout.write(`BASE: ${c.cyan(base)}\n`);
  process.stdout.write(`Active account (lastKnownAccountUuid): ${activeAccount ? c.green(activeAccount) : c.yellow("unknown")}\n`);

  const locations = discoverLocations(base);
  if (locations.length === 0) fail("no session locations discovered under either tree.");

  process.stdout.write("\n" + c.bold("Discovered locations:") + "\n");
  locations.forEach((loc, i) => {
    const s = summarizeLocation(base, loc);
    const activeMark = loc.account === activeAccount ? c.green("  [ACTIVE]") : "";
    process.stdout.write(`  ${c.bold(String(i + 1))}) ${c.cyan(loc.key)}  ${c.dim(`(${s.total} sessions)`)}${activeMark}\n`);
    for (const t of s.recentTitles) process.stdout.write(`       ${c.dim("· " + t)}\n`);
  });

  // Determine whether we must go interactive.
  const needCanonicalPick = !args.canonical;
  const needSourcePick = !args.sources && !args.allOthers;
  const interactive = needCanonicalPick || needSourcePick;

  let rl: readline.Interface | null = null;
  const getRl = () => {
    if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
    return rl;
  };

  try {
    // Canonical
    let canonical: Location;
    if (args.canonical) canonical = matchLocation(args.canonical, locations);
    else {
      requireTty("Choosing the canonical location");
      canonical = await pickCanonical(getRl(), locations);
    }

    // Sources
    let sources: Location[];
    if (args.allOthers) sources = locations.filter((l) => l.key !== canonical.key);
    else if (args.sources) {
      sources = args.sources.map((k) => matchLocation(k, locations)).filter((l) => l.key !== canonical.key);
    } else {
      requireTty("Choosing source locations");
      sources = await pickSources(getRl(), locations, canonical);
    }

    // Link mode
    let linkMode: boolean;
    if (args.link) linkMode = true;
    else if (interactive) linkMode = await pickLinkMode(getRl());
    else linkMode = false;

    process.stdout.write("\n" + c.bold("Selection:") + "\n");
    process.stdout.write(`  Canonical: ${c.cyan(canonical.key)}\n`);
    process.stdout.write(
      `  Sources:   ${sources.length ? sources.map((s) => c.blue(s.key)).join(", ") : c.dim("(none)")}\n`
    );
    process.stdout.write(`  Mode:      ${linkMode ? c.red("MERGE + LINK (destructive)") : c.green("MERGE only")}\n`);

    if (sources.length === 0)
      process.stdout.write(
        c.yellow("\nNo source locations differ from canonical — nothing to merge. (This is a valid no-op.)\n")
      );

    const plan = buildPlan(base, canonical, sources, linkMode);
    printPlan(plan, linkMode);

    if (!args.apply) {
      process.stdout.write("\n" + c.bold(c.yellow("DRY RUN — no filesystem changes were made.")) + "\n");
      process.stdout.write(c.dim("Re-run with --apply to execute the plan above.\n"));
      levelDbReport(base, plan);
      return;
    }

    // --- apply path ---
    const hasWork =
      plan.sourcePlans.some((sp) => sp.copies.length > 0) ||
      (plan.spacesMerge?.willWrite ?? false) ||
      plan.linkPlans.some((lp) => !lp.alreadySymlink);
    if (!hasWork) {
      process.stdout.write("\n" + c.green("Nothing to apply — plan is a no-op. Done.") + "\n");
      levelDbReport(base, plan);
      return;
    }

    if (linkMode)
      process.stdout.write(
        "\n" +
          c.red(c.bold("⚠  DESTRUCTIVE: LINK will back up and REPLACE source org dirs with symlinks.")) +
          "\n" +
          c.yellow("   QUIT the Claude desktop app now, before proceeding.\n")
      );

    if (!args.yes) {
      requireTty("Confirmation");
      const ok = await confirm(getRl(), linkMode ? "Proceed with MERGE + LINK?" : "Proceed with MERGE?");
      if (!ok) {
        process.stdout.write(c.yellow("Aborted — no changes made.\n"));
        return;
      }
    }

    const result = executePlan(plan, linkMode);

    process.stdout.write("\n" + c.bold("SUMMARY") + "\n");
    process.stdout.write(`  Copied: ${c.green(String(result.copiedFiles))} file(s), ${c.green(String(result.copiedDirs))} dir(s)\n`);
    process.stdout.write(`  spaces.json: ${result.spacesWritten ? c.green("written") : c.dim("unchanged")}\n`);
    if (linkMode)
      process.stdout.write(`  Linked: ${c.green(String(result.linked))} dir(s) symlinked, ${result.backedUp} backed up\n`);
    if (result.errors.length) {
      process.stdout.write(c.red(`  ${result.errors.length} error(s):\n`));
      for (const e of result.errors) process.stdout.write(c.red(`    - ${e}\n`));
    }

    levelDbReport(base, plan);
    process.stdout.write("\n" + c.cyan("Reopen the Claude desktop app to see the merged sessions.") + "\n");
  } finally {
    if (rl) rl.close();
    closeLogging();
  }
}

main().catch((err) => {
  process.stderr.write(c.red(`\nunexpected error: ${(err as Error).stack || err}`) + "\n");
  process.exit(1);
});
