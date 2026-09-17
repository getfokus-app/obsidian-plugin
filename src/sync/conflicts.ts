/**
 * Naming for conflict copies.
 *
 * When both sides moved, nothing is thrown away: the vault file keeps what the
 * user has in front of them, and the Fokus version is written beside it as its
 * own file. Reconciling is then an ordinary editing job with both versions
 * visible, rather than a prompt asking someone to choose blind.
 */
export interface ConflictName {
  path: string;
  basename: string;
}

/**
 * `Notes/Plan.md` → `Notes/Plan (conflict 2026-09-17).md`, with ` 2`, ` 3`
 * appended while that name is taken — a second conflict on the same day must
 * not overwrite the first.
 */
export async function conflictPathFor(
  path: string,
  when: Date,
  exists: (candidate: string) => Promise<boolean>,
): Promise<ConflictName> {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const file = path.slice(folder.length);
  const stem = file.replace(/\.md$/i, '');
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;

  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : ` ${attempt + 1}`;
    const basename = `${stem} (conflict ${day}${suffix})`;
    const candidate = `${folder}${basename}.md`;
    if (!(await exists(candidate))) return { path: candidate, basename };
  }

  // Beyond a hundred in one day something is looping; a timestamp is still
  // better than silently overwriting somebody's work.
  const basename = `${stem} (conflict ${day} ${when.getTime()})`;
  return { path: `${folder}${basename}.md`, basename };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
