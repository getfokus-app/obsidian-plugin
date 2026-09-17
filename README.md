# Fokus Sync

Sync your Obsidian vault notes into [Fokus](https://getfokus.com).

Notes flow both directions, with edit locking, conflict copies, and embedded
images uploaded to Fokus.

Desktop only for now.

## What it sends where

Every synced note is sent to your own Fokus account at `https://api.getfokus.com`.
Endpoints used: `/v1/notes` (note content), `/v1/uploads` (embedded images),
`/v1/tags` (tag names), `/v1/workspaces`, and `/integrations/obsidian/*` (the
vault registration and its folder settings). Nothing else leaves the vault, and
there is no telemetry.

Your access token is stored in `.obsidian/plugins/fokus-sync/data.json`, in plain
text — Obsidian has no secure storage. If your vault syncs through iCloud,
Dropbox or git, the token travels with it. Use a token you can revoke on its own,
and revoke it if the vault is ever shared.

## Getting a token

In Fokus, go to **Settings → Integrations → Obsidian**, create a token under
**API tokens**, and paste it into the plugin's settings. The value is shown once;
if you lose it, revoke that token and create another. Name it after this vault so
you can tell which one to revoke later.

A token grants full access to your account for 90 days. See the storage warning
above before putting one in a vault you share or back up to someone else's
computer.

## How the mapping works

Each synced file gets a `fokus-id` in its frontmatter. That key is the mapping:
it survives renames, moves, a plugin reinstall, and the vault being opened on
another machine. The plugin's own `data.json` is only a cache — delete it and the
links rebuild from the frontmatter.

Set `fokus-sync: false` in a note's frontmatter to keep it out of sync.

Duplicating a note copies its `fokus-id` too. The plugin notices, leaves the
original alone, and gives the copy an id of its own — otherwise the two files
would overwrite each other's note forever.

## Tags and buckets

`#tags` in the body and `tags:` in frontmatter both become Fokus tags, matched by
name and created if they don't exist. Tags inside code — a `# heading` in a
fenced block, a `#1570EF` colour, a `#define` — are ignored, because they aren't
things you tagged.

Which Fokus bucket a note lands in is configured **in Fokus**, on the Obsidian
connection, as a vault-folder → bucket mapping. The most specific folder wins, so
mapping both `Work` and `Work/Clients` files a client note in the client bucket.

## Images and attachments

An embedded image is uploaded to Fokus and rendered there, while **the file in
your vault is left exactly as you wrote it** — `![[diagram.png]]` stays
`![[diagram.png]]`. The plugin keeps a private map from your embed to the
uploaded URL and translates in both directions, so the two views never have to
agree on syntax.

`png`, `jpg`, `gif`, `webp`, `svg` and `pdf` are uploaded; that list matches what
the server accepts, so nothing is attempted that would be refused. An embed
inside a fenced code block is an example of the syntax, not an attachment, and is
left alone.

Replacing an image with a new version under the same filename is noticed and
re-uploaded the next time that note syncs. An upload that fails — offline,
rate-limited, a file that has gone missing — leaves the embed as text in Fokus
and is retried; it never silently drops the image.

Uploads are paced to stay inside the server's limit, so a note with dozens of
images takes a few minutes to finish rather than being refused part-way. The
edit lock is renewed while that runs.

## What comes back down

Only notes that started in your vault. A note written natively in Fokus stays
there — this sync never invents a filename or picks a folder for you.

While you are editing a note, the plugin holds an edit lock, so Fokus shows it
read-only instead of racing you. The lock expires on its own, so a crash or a
closed laptop never leaves a note stuck.

## When both sides changed

Nothing is discarded. Your file keeps what you have in front of you, and the
Fokus version is written beside it as `Note (conflict 2026-09-17).md`. That copy is
marked `fokus-sync: false`, so it is never itself synced — it is just a file you
can read, merge from, and delete. Both sides then converge on your local version.

## Deleting

Deleting a file stops it syncing; its Fokus note is left exactly as it is. A file
can vanish for reasons that are not a decision to delete anything — a move out of
a synced folder, a vault-sync hiccup, a stray keystroke — and acting on that is
not recoverable. Put the file back with its `fokus-id` intact and it re-links.

## Commands

- **Sync now** — push whatever is currently queued.
- **Check Fokus for changes** — pull immediately rather than waiting for the poll.
- **Sync every note in the selected folders** — a first full sync. It asks first
  and tells you how many notes are in scope and how many aren't in Fokus yet; it
  is never automatic.

The queue is persisted, so quitting or crashing mid-sync resumes where it
stopped rather than dropping the rest.

## Markdown fidelity

Content is converted by Fokus, not by this plugin, so there is exactly one
definition of "canonical markdown" and the file cannot drift from it.

The first time a file syncs it is normalised to that canonical form, which may
rewrite it once (`* ` becomes `- `, `_italic_` becomes `*italic*`, tables lose
column alignment). After that it is stable.

Whether the content settles is checked **on the server, before your file is
touched**: the plugin re-sends the server's own output until it stops changing.
Some markdown genuinely needs three passes — escaped `\*stars\*` is the known
case — so one round trip would prove nothing. A file that still has not settled
is refused: its body is left exactly as you wrote it, and it stays refused until
you edit it. Only a `fokus-id` is added, so the refusal is remembered and the
note is not created twice.

Known lossy constructs, verified rather than assumed: escaped markdown
(`\*stars\*`) loses its backslashes; a wikilink alias inside a table cell
(`| [[A\|B]] |`) breaks the row; `[text](<path with spaces.md>)` loses its angle
brackets and the link with them; a plain bullet in a list that also contains a
task becomes a task.

Notes authored in Fokus that contain mentions, drawings, handwritten pages or
collapsible sections cannot be represented in markdown. The server refuses a
markdown write to those rather than flattening them.

## Development

```bash
npm install
npm run dev          # watch build into main.js
npm run build        # typecheck + production bundle
npm test             # unit + engine tests (no backend needed)
npm run test:e2e     # the real engine against a local backend
npm run types:check  # tsc only
npm run format:check # prettier
```

`npm run test:e2e` needs the Fokus backend running locally
(`cd backend && docker compose up -d`) and refuses to run against anything but
localhost — it creates and rewrites notes.

### Testing shape

The engine talks to a `VaultPort` and a `FokusPort` and imports neither Obsidian
nor the network. The e2e harness swaps in a real temp-directory vault and Node
fetch, so the code under test is the code that ships.

Some things the harness cannot reach and only a real vault proves: the settings
tab, the file watcher firing, `processFrontMatter`'s YAML round-trip, and unload
cleanup. `src/main.ts` imports Obsidian, so the unit suite cannot load it at all
— behaviour wired only there is asserted against the built `main.js` in
`tests/bundle.test.ts`, which is the only place a helper nobody calls looks
different from one that is called.

## Licence

MIT
