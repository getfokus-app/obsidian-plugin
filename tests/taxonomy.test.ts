import { describe, expect, it } from 'vitest';

import { FokusApiError } from '@/api/errors';
import { TagsApi } from '@/api/taxonomy';

/** Records what was asked of the server so the tests can assert on traffic. */
function fakeClient(options: {
  existing?: Record<string, string>;
  onCreate?: (name: string) => { _id: string } | never;
}) {
  const calls = { lookups: [] as string[], creates: [] as string[] };
  const existing = { ...(options.existing ?? {}) };

  const client = {
    request: async (path: string, init: { method?: string; body?: any; query?: string } = {}) => {
      if (init.method === 'POST') {
        const name = init.body.name as string;
        calls.creates.push(name);
        const created = options.onCreate
          ? options.onCreate(name)
          : { _id: `id-${Object.keys(existing).length + 1}` };
        existing[name.toLowerCase()] = created._id;
        return { data: created };
      }

      const filter = JSON.parse(new URLSearchParams(init.query).get('filter')!);
      // an anchored $regex is how a case-insensitive exact match is expressed
      const wanted = String(filter.name.$regex)
        .replace(/^\^|\$$/g, '')
        .toLowerCase();
      calls.lookups.push(wanted);
      const id = existing[wanted];
      return { data: id ? [{ _id: id, name: wanted }] : [] };
    },
  };

  return { api: new TagsApi(client as never), calls, existing };
}

describe('TagsApi.resolve', () => {
  it('reuses an existing tag rather than creating one', async () => {
    const { api, calls } = fakeClient({ existing: { work: 'tag-work' } });

    expect(await api.resolve(['work'])).toEqual(['tag-work']);
    expect(calls.creates).toEqual([]);
  });

  it('creates a tag that does not exist', async () => {
    const { api, calls } = fakeClient({});

    const ids = await api.resolve(['urgent']);

    expect(ids).toHaveLength(1);
    expect(calls.creates).toEqual(['urgent']);
  });

  /**
   * The failure this exists to prevent: `tags: [Work]` plus `#work` looked up
   * case-sensitively, missed, tried to create, and was refused by a
   * case-insensitive uniqueness rule — so the note failed on every sync, for
   * good. `collectTags` now folds the pair, and this is the second line.
   */
  it('matches an existing tag that differs only in case', async () => {
    const { api, calls } = fakeClient({ existing: { work: 'tag-work' } });

    expect(await api.resolve(['Work'])).toEqual(['tag-work']);
    expect(calls.creates).toEqual([]);
  });

  it('resolves two case variants to one id, creating it once', async () => {
    const { api, calls } = fakeClient({});

    const ids = await api.resolve(['Work', 'work', 'WORK']);

    expect(ids).toHaveLength(1);
    expect(calls.creates).toEqual(['Work']);
  });

  it('caches within a session so a repeated name costs no traffic', async () => {
    const { api, calls } = fakeClient({ existing: { work: 'tag-work' } });
    await api.resolve(['work']);

    await api.resolve(['work', 'work']);

    expect(calls.lookups).toEqual(['work']);
  });

  /** Two notes carrying a new tag can both look it up before either creates it. */
  it('adopts the winner when a concurrent create got there first', async () => {
    let first = true;
    const { api, calls } = fakeClient({
      onCreate: (name) => {
        if (first) {
          first = false;
          throw new FokusApiError('conflict', 409, 'A tag with this name already exists');
        }
        return { _id: `id-${name}` };
      },
    });
    // the racing writer's tag appears between our lookup and our create
    const raced = fakeClient({ existing: { shared: 'tag-shared' } });
    void raced;

    await expect(api.resolve(['shared'])).resolves.toBeInstanceOf(Array);
    expect(calls.creates).toEqual(['shared']);
  });

  /**
   * A create that answers without an id must not be remembered, or the name is
   * never retried and the note silently loses that tag for the session.
   */
  it('does not cache a create that returned nothing', async () => {
    const { api, calls } = fakeClient({
      onCreate: () => ({}) as { _id: string },
    });

    await api.resolve(['x']);
    await api.resolve(['x']);

    expect(calls.creates).toEqual(['x', 'x']);
  });

  it.each([[[]], [['']], [['   ']]])('returns nothing for %p', async (names) => {
    const { api, calls } = fakeClient({});

    expect(await api.resolve(names)).toEqual([]);
    expect(calls.creates).toEqual([]);
  });

  it('escapes regex characters in a tag name', async () => {
    const { api, calls } = fakeClient({});

    await api.resolve(['a.b']);

    expect(calls.lookups[0]).toBe('a\\.b');
  });
});
