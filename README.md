# claude-session-merge

Merge and sync **Claude desktop app** sessions across accounts — macOS, zero dependencies, dry-run by default.

> When you log into a different Claude account, the desktop app shows an empty session list. Your conversations aren't gone — the app just scopes its session index per account. This tool reconciles that: it merges every account's session list into one canonical location and (optionally) symlinks the others to it so they stay in sync.

Not affiliated with Anthropic. It only reorganizes local files the desktop app already wrote; it never uploads anything and never touches your transcripts.

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

## Install

Requires [Bun](https://bun.sh) and macOS.

```sh
git clone https://github.com/sebryu/claude-session-merge.git
cd claude-session-merge
bun claude-session-merge.ts        # dry-run: discovers accounts, prints a plan, changes nothing
```

Or grab just the script:

```sh
curl -fsSL https://raw.githubusercontent.com/sebryu/claude-session-merge/main/claude-session-merge.ts -o claude-session-merge.ts
bun claude-session-merge.ts
```

## Usage

```
bun claude-session-merge.ts [flags]
```

Everything is a **dry run** until you pass `--apply`.

```sh
# 1. See what's there (interactive picker + plan, no changes)
bun claude-session-merge.ts

# 2. Merge one account's sessions into another
bun claude-session-merge.ts --canonical=<acct>/<org> --sources=<acct>/<org> --apply

# 3. Keep them in sync: quit the desktop app first, then link
bun claude-session-merge.ts --canonical=<acct>/<org> --sources=<acct>/<org> --link --apply
```

| Flag | Meaning |
|---|---|
| `--canonical=<a>/<o>` | Target location that receives the merged sessions |
| `--sources=<a>/<o>[,...]` | Source locations to merge from |
| `--all-others` | Use every non-canonical location as a source |
| `--link` | Also do Step B: back up each source folder and symlink it to canonical |
| `--apply` | Execute. Without it, the tool is a dry run |
| `--yes`, `-y` | Skip the confirmation prompt on `--apply` |
| `--help`, `-h` | Show help |

## Safety

- **Dry-run by default** — nothing changes without `--apply`.
- **Never overwrites** canonical files; conflicts are reported and canonical is kept.
- **Backs up** every folder before replacing it with a symlink (`*.bak-<timestamp>`).
- **Read-only** on LevelDB; **never touches** `~/.claude` transcripts.
- Quit the desktop app before `--link` so it doesn't recreate the folders mid-operation.

To undo a `--link`: delete the symlink and rename its `*.bak-<timestamp>` back.

## License

MIT
