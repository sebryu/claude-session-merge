# claude-desktop-merge

Merge and sync **Claude desktop app** sessions across accounts — macOS, zero dependencies, dry-run by default.

> When you log into a different Claude account, the desktop app shows an empty session list. Your conversations aren't gone — the app just scopes its session index per account. This tool reconciles that: it merges every account's session list into one canonical location and (optionally) symlinks the others to it so they stay in sync.

Not affiliated with Anthropic. It only reorganizes local files the desktop app already wrote; it never uploads anything and never touches your transcripts.

## Install (macOS)

Pick whichever you like — all three give you a `claude-desktop-merge` command and **none of them require you to install anything first**.

**1. One-line installer** — the simplest. Downloads the tool and puts it on your PATH; if you don't already have a runtime it installs [Bun](https://bun.sh) for you.

```sh
curl -fsSL https://raw.githubusercontent.com/sebryu/claude-desktop-merge/main/install.sh | bash
```

**2. npm** — if you already have Node:

```sh
npx claude-desktop-merge            # run once, nothing installed
# or install the command globally:
npm install -g claude-desktop-merge
```

**3. From source** — if you want to read or hack on it:

```sh
git clone https://github.com/sebryu/claude-desktop-merge.git
cd claude-desktop-merge
bun claude-desktop-merge.ts         # or: node claude-desktop-merge.ts   (Node >= 23.6)
```

Then run it — it's a **dry run** that changes nothing:

```sh
claude-desktop-merge                # discover accounts, print a plan
claude-desktop-merge --revert       # preview undoing a previous --link
```

That's the whole tool — **one command**; everything else is a flag, and **nothing changes until you add `--apply`.** See [Usage](#usage) for the flag table.

> **Uninstall.** Installer: `rm ~/.local/bin/claude-desktop-merge && rm -rf ~/.local/share/claude-desktop-merge`. npm: `npm uninstall -g claude-desktop-merge`.

---

## The storage model (why this is safe)

The macOS desktop app keeps two different things in two different places:

| | Location | Account-scoped? |
|---|---|---|
| **Transcripts** (the actual conversation) | `~/.claude/projects/<encoded-cwd>/<id>.jsonl` | **No** — global, shared with the CLI |
| **Session index** (pointer files: title, model, cwd, archive state) | `~/Library/Application Support/Claude/{claude-code-sessions,local-agent-mode-sessions}/<accountUuid>/<orgUuid>/local_<id>.json` | **Yes** — one folder per account/org |

Because the transcripts are global, switching accounts never loses a conversation — the desktop UI just stops *listing* it, since it reads a different `<account>/<org>` folder. This tool only reorganizes the small pointer files. **It never reads, writes, moves, or deletes anything under `~/.claude` or any `.jsonl`.**

## How it works — canonical merge, then link

1. **MERGE** (non-destructive) — pick one **canonical** `<account>/<org>`. Copy the pointer files that exist only in other accounts *into* canonical. Union `spaces.json` by id. Archive flags ride along inside each pointer file.
2. **LINK** (opt-in, `--link`) — back up each other account's folder to `*.bak-<timestamp>` and replace it with a symlink to canonical, so all accounts share one live set going forward.

The one rule that keeps it consistent: **copy _into_ canonical; symlink every other account _at_ canonical.** Never copy into a folder you then link away.

Pinned/grouped sessions live in a single global LevelDB keyed by session id, so they follow the merged sessions automatically — the tool reads it read-only to report which pins carry over, and never edits it.

## Usage

```
claude-desktop-merge [flags]
```

Everything is a **dry run** until you pass `--apply`.

```sh
# 1. See what's there (interactive picker + plan, no changes)
claude-desktop-merge

# 2. Merge one account's sessions into another
claude-desktop-merge --canonical=<acct>/<org> --sources=<acct>/<org> --apply

# 3. Keep them in sync: quit the desktop app first, then link
claude-desktop-merge --canonical=<acct>/<org> --sources=<acct>/<org> --link --apply

# 4. Changed your mind? Undo the linking (quit the desktop app first)
claude-desktop-merge --revert            # dry-run: preview what gets restored
claude-desktop-merge --revert --apply    # restore the pre-symlink backups
```

| Flag | Meaning |
|---|---|
| `--canonical=<a>/<o>` | Target location that receives the merged sessions |
| `--sources=<a>/<o>[,...]` | Source locations to merge from |
| `--all-others` | Use every non-canonical location as a source |
| `--link` | Also do Step B: back up each source folder and symlink it to canonical |
| `--revert` | Undo a previous `--link`: restore each `*.bak-<ts>` backup over its symlink |
| `--apply` | Execute. Without it, the tool is a dry run |
| `--yes`, `-y` | Skip the confirmation prompt on `--apply` |
| `--log-file=<path>` | Write the run log here (default: `logs/desktop-merge-<ts>.log`) |
| `--no-log` | Disable file logging for this run |
| `--help`, `-h` | Show help |

## Reverting a link

`--link` is fully reversible. It leaves a `*.bak-<timestamp>` backup next to every folder it turns into a symlink, and `--revert` walks those backups to put things back:

```sh
claude-desktop-merge --revert          # dry-run: show which symlinks would be restored
claude-desktop-merge --revert --apply  # drop each symlink, move the newest backup back
```

- It only ever removes a **symlink**. If a real directory has reappeared at the original path (e.g. the desktop app recreated it), that's reported as a conflict and left untouched — nothing is overwritten.
- When several backups exist for the same folder, the **newest** is restored and older ones are left in place.
- Quit the desktop app first, same as with `--link`.

The merged copies inside canonical are *not* touched by revert — reverting only undoes the symlinking (Step B), returning each account to its own independent folder.

## Logging

Every run is mirrored to a log file (ANSI colors stripped) so you have a record of exactly what was planned and applied:

```
logs/desktop-merge-<timestamp>.log     # default, next to the script
```

- `--log-file=<path>` writes the log somewhere else.
- `--no-log` turns file logging off for that run.

The `logs/` folder is git-ignored.

## Safety

- **Dry-run by default** — nothing changes without `--apply`.
- **Never overwrites** canonical files; conflicts are reported and canonical is kept.
- **Backs up** every folder before replacing it with a symlink (`*.bak-<timestamp>`), and `--revert` restores those backups.
- **Read-only** on LevelDB; **never touches** `~/.claude` transcripts.
- **Every run is logged** to a file for an audit trail.
- Quit the desktop app before `--link` or `--revert` so it doesn't recreate the folders mid-operation.

## License

MIT
