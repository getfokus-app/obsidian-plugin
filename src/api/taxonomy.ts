import { FokusClient } from './client';
import { FokusApiError } from './errors';
import { buildListQuery } from './filter-builder';

export interface Tag {
  _id: string;
  name: string;
}

/**
 * Tags by name.
 *
 * Fokus stores tags as documents and a note references them by id, so a vault's
 * `#work` has to be resolved to an id before the note can carry it. Names are
 * cached for the session: a vault of any size repeats the same handful of tags,
 * and a lookup per note per tag would be most of the sync's traffic.
 */
export class TagsApi {
  /** Keyed lowercase, because Fokus's uniqueness on tag names is too. */
  private byName = new Map<string, string>();

  constructor(private client: FokusClient) {}

  /** Resolve names to ids, creating any that do not exist yet. */
  async resolve(names: string[]): Promise<string[]> {
    const ids: string[] = [];

    // Checked per name inside the loop, not computed up front: two names
    // differing only in case resolve to the same tag, and a precomputed
    // "missing" list would try to create the second one after the first had
    // already filled the cache.
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;

      const key = name.toLowerCase();
      let id = this.byName.get(key);
      if (!id) {
        id = (await this.findByName(name)) ?? (await this.createOrAdopt(name));
        // A failed create must not be remembered, or the name is never retried
        // and the note silently loses that tag for the rest of the session.
        if (id) this.byName.set(key, id);
      }
      if (id) ids.push(id);
    }

    return [...new Set(ids)];
  }

  /**
   * Case-insensitive on purpose. `$eq` matches exactly, so `#work` missed an
   * existing `Work`, tried to create it, and was refused by a case-insensitive
   * uniqueness rule — the note then failed on every sync, permanently. The fps
   * filter parser adds `$options: 'i'` to every `$regex`, so an anchored
   * pattern is an exact, case-insensitive match.
   */
  private async findByName(name: string): Promise<string | undefined> {
    const { data } = await this.client.request<{ data: Tag[] }>('/v1/tags', {
      query: buildListQuery({
        filter: { name: { $regex: `^${escapeRegex(name)}$` } },
        limit: 1,
      }),
    });
    return data?.[0]?._id;
  }

  /**
   * Create, and treat "already exists" as a race rather than a failure — two
   * notes carrying a new tag can be pushed close enough together that both look
   * it up before either creates it.
   */
  private async createOrAdopt(name: string): Promise<string | undefined> {
    try {
      const { data } = await this.client.request<{ data: Tag }>('/v1/tags', {
        method: 'POST',
        body: { name },
      });
      return data?._id;
    } catch (error) {
      if (error instanceof FokusApiError && error.kind === 'conflict') {
        return await this.findByName(name);
      }
      throw error;
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
