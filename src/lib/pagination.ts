export const recipePageSize = 24;

export type PaginationPage<T> = {
  readonly currentPage: number;
  readonly items: readonly T[];
  readonly totalPages: number;
};

export function getPageCount(itemCount: number) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new Error(`Pagination item count must be a nonnegative safe integer: ${itemCount}`);
  }
  return Math.ceil(itemCount / recipePageSize);
}

export function getPageNumbers(itemCount: number) {
  return Array.from(
    { length: getPageCount(itemCount) },
    (_, index) => index + 1
  );
}

export function parsePageNumber(value: string) {
  if (!/^[1-9]\d*$/u.test(value)) {
    return undefined;
  }
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : undefined;
}

export function getPaginationPage<T>(
  items: readonly T[],
  page: number
): PaginationPage<T> | undefined {
  const totalPages = getPageCount(items.length);
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || page > totalPages
  ) {
    return undefined;
  }

  const start = (page - 1) * recipePageSize;
  return {
    currentPage: page,
    items: items.slice(start, start + recipePageSize),
    totalPages
  };
}
