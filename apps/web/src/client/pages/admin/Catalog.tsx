import { useEffect, useRef, useState } from "react";
import { Alert, Field, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
import { useSlashFocus } from "../../lib/useSlashFocus.ts";
import { Cover } from "./Cover.tsx";

interface TitleRow {
  id: string;
  title: string;
  authors: string;
  coverUrl: string | null;
  copies: number;
  onLoan: number;
  needsLabel: number;
}

export function CatalogPage() {
  const [query, setQuery] = useState("");
  const [titles, setTitles] = useState<TitleRow[] | null>(null);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useSlashFocus(search);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        api<{ titles: TitleRow[] }>(`/catalog/titles?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        })
          .then((res) => {
            setTitles(res.titles);
            setError("");
          })
          .catch((e) => {
            const message = errorMessage(e);
            if (message) setError(message);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <Layout
      title="Catalog"
      width="wide"
      actions={
        <Link href="/admin/add" className="btn btn--primary">
          Add books
        </Link>
      }
    >
      <Field
        ref={search}
        label="Search"
        type="search"
        hint="Title, author or ISBN"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="kbd-hint desktop-only">
        Press <kbd>/</kbd> to search from anywhere on this page.
      </p>
      <Alert>{error}</Alert>
      {titles === null ? (
        <Loading label="Loading the catalog…" />
      ) : titles.length === 0 ? (
        <p>
          {query
            ? "No books match that search."
            : "No books yet. Use Add books to scan your first one."}
        </p>
      ) : (
        <>
          <p className="muted" role="status">
            {titles.length === 200
              ? "Showing the newest 200 books. Search to find others."
              : `${titles.length} ${titles.length === 1 ? "book" : "books"}`}
          </p>
          <ul className="book-list book-list--grid">
            {titles.map((t) => (
              <li key={t.id}>
                <Link href={`/admin/catalog/${t.id}`} className="book-row">
                  <Cover url={t.coverUrl} title={t.title} size="sm" />
                  <span className="book-row__text">
                    <strong>{t.title}</strong>
                    {t.authors && <span className="muted">{t.authors}</span>}
                    <span className="muted">
                      {t.copies} {t.copies === 1 ? "copy" : "copies"}
                      {t.onLoan > 0 && ` · ${t.onLoan} on loan`}
                      {t.needsLabel > 0 &&
                        ` · ${t.needsLabel} ${t.needsLabel === 1 ? "needs a label" : "need labels"}`}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Layout>
  );
}
