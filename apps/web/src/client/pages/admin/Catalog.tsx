import { useEffect, useState } from "react";
import { Alert, Field, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";
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
    <Layout title="Catalog" back="/admin">
      <p>
        <Link href="/admin/add" className="btn btn--primary">
          Add books
        </Link>
      </p>
      <Field
        label="Search"
        type="search"
        hint="Title, author or ISBN"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Alert>{error}</Alert>
      {titles === null ? (
        <Loading label="Loading the catalog…" />
      ) : titles.length === 0 ? (
        <p>{query ? "No books match that search." : "No books yet. Add your first one above."}</p>
      ) : (
        <>
          <p className="muted" role="status">
            {titles.length === 200
              ? "Showing the newest 200 books. Search to find others."
              : `${titles.length} ${titles.length === 1 ? "book" : "books"}`}
          </p>
          <ul className="book-list">
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
