/**
 * Query encoding for the backend's list endpoints (`@fokus-app/nestjs-mongoose-fps`).
 *
 * Two rules that are easy to get wrong and fail loudly when you do: the filter
 * travels as one URL-encoded JSON blob, and a bare scalar is rejected — every
 * value has to be wrapped in an operator, so `source` becomes
 * `{"source":{"$eq":"..."}}`. The parser also throws on any property the
 * backend has not explicitly exposed for filtering, rather than ignoring it.
 */
export interface ListQuery {
  filter?: Record<string, unknown>;
  sort?: string;
  page?: number;
  limit?: number;
  /** Ask the server to render note content as markdown rather than TipTap JSON. */
  contentFormat?: 'markdown';
}

export function buildListQuery(query: ListQuery): string {
  const params = new URLSearchParams();

  if (query.filter && Object.keys(query.filter).length > 0) {
    params.set('filter', JSON.stringify(query.filter));
  }
  if (query.sort) params.set('sort', query.sort);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.contentFormat) params.set('contentFormat', query.contentFormat);

  return params.toString();
}

/** Wraps a scalar as `$eq`, which is the only form the filter parser accepts. */
export function eq(value: string): Record<string, string> {
  return { $eq: value };
}

/** `updatedAt` since a cursor, for the incremental pull. */
export function since(cursor: string): Record<string, string> {
  return { $gte: cursor };
}
