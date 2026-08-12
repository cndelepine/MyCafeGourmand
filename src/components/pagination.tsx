import Link from "next/link";

type PaginationLabels = {
  readonly currentPage: (currentPage: number, totalPages: number) => string;
  readonly next: string;
  readonly navigation: string;
  readonly previous: string;
};

type PaginationProps = {
  readonly currentPage: number;
  readonly getPagePath: (page: number) => string;
  readonly labels: PaginationLabels;
  readonly totalPages: number;
};

export function Pagination({
  currentPage,
  getPagePath,
  labels,
  totalPages
}: PaginationProps) {
  if (totalPages <= 1) {
    return null;
  }

  return (
    <nav aria-label={labels.navigation} className="pagination">
      <p>{labels.currentPage(currentPage, totalPages)}</p>
      <ol>
        <li>
          {currentPage > 1 ? (
            <Link href={getPagePath(currentPage - 1)} rel="prev">
              {labels.previous}
            </Link>
          ) : (
            <span aria-disabled="true">{labels.previous}</span>
          )}
        </li>
        {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
          <li key={page}>
            {page === currentPage ? (
              <span aria-current="page">{page}</span>
            ) : (
              <Link href={getPagePath(page)}>{page}</Link>
            )}
          </li>
        ))}
        <li>
          {currentPage < totalPages ? (
            <Link href={getPagePath(currentPage + 1)} rel="next">
              {labels.next}
            </Link>
          ) : (
            <span aria-disabled="true">{labels.next}</span>
          )}
        </li>
      </ol>
    </nav>
  );
}
