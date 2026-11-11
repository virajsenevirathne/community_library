import { type ChangeEvent, useState } from "react";
import { Alert, Button, Layout } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link } from "../../lib/router.tsx";

interface Row {
  line: number;
  familyName: string;
  email: string;
  problem:
    | null
    | "invalid_email"
    | "missing_family"
    | "duplicate_in_file"
    | "already_member"
    | "already_invited";
}

interface Preview {
  error: string | null;
  rows: Row[];
  families: number;
  invites: number;
}

const PROBLEMS: Record<NonNullable<Row["problem"]>, string> = {
  invalid_email: "Email doesn't look right",
  missing_family: "No family name",
  duplicate_in_file: "Same email appears earlier in the file",
  already_member: "Already a member",
  already_invited: "Already invited",
};

/** Import families from a parent contact list exported as CSV. */
export function ImportPage() {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [result, setResult] = useState<{ families: number; invites: number } | null>(null);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setPreview(null);
    setResult(null);
    if (!file) return;
    setFileName("");
    setCsv("");
    if (file.size > 500_000) {
      setError("That file is too big. Export just the family name and email columns.");
      return;
    }
    try {
      setCsv(await file.text());
      setFileName(file.name);
      setError("");
    } catch {
      setError("That file couldn't be read. Save it again as a CSV file and try once more.");
    }
  };

  const check = async () => {
    setBusy("preview");
    setError("");
    try {
      setPreview(await api<Preview>("/admin/import/preview", { body: { csv } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const importNow = async () => {
    setBusy("import");
    setError("");
    try {
      setResult(
        await api<{ families: number; invites: number }>("/admin/import", { body: { csv } }),
      );
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const skipped = preview?.rows.filter((r) => r.problem) ?? [];

  return (
    <Layout
      title="Import families"
      back="/admin/families"
      focusKey={result ? "done" : preview ? "preview" : "start"}
    >
      <Alert>{error}</Alert>
      {result ? (
        <div className="stack">
          <Alert kind="success">
            Added {result.families} {result.families === 1 ? "family" : "families"} and{" "}
            {result.invites} {result.invites === 1 ? "invitation" : "invitations"}. Invitations go
            out in batches to stay within the daily email limit, so some may arrive tomorrow.
          </Alert>
          <Link href="/admin/families" className="btn btn--primary">
            See families
          </Link>
        </div>
      ) : (
        <>
          <p className="lead">
            Export the parent contact list from your centre's system as a CSV file, then choose it
            here.
          </p>
          <ul>
            <li>
              The first row needs headings, including <strong>Family name</strong> (or Surname) and{" "}
              <strong>Email</strong>.
            </li>
            <li>One row per parent. Rows with the same family name become one family.</li>
            <li>
              Only those two columns are read. Children's names and anything else are ignored.
            </li>
            <li>The file itself is not kept.</li>
            <li>
              In Excel, choose File › Save As › <strong>CSV (comma delimited)</strong>.
            </li>
          </ul>
          <div className="field">
            <label htmlFor="csv-file">CSV file</label>
            <input id="csv-file" type="file" accept=".csv,text/csv" onChange={readFile} />
          </div>
          {fileName && !preview && (
            <Button onClick={check} busy={busy === "preview"} busyLabel="Checking…">
              Check {fileName}
            </Button>
          )}
        </>
      )}

      {preview && !result && (
        <div className="stack">
          {preview.error ? (
            <>
              <Alert>{preview.error}</Alert>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Choose another file
              </Button>
            </>
          ) : (
            <>
              <p className="lead">
                Ready to add <strong>{preview.families}</strong>{" "}
                {preview.families === 1 ? "family" : "families"} and invite{" "}
                <strong>{preview.invites}</strong> {preview.invites === 1 ? "parent" : "parents"}.
                {skipped.length > 0 &&
                  ` ${skipped.length} ${skipped.length === 1 ? "row is" : "rows are"} skipped (listed below).`}
              </p>
              <div className="row">
                <Button
                  onClick={importNow}
                  disabled={preview.invites === 0}
                  busy={busy === "import"}
                  busyLabel="Importing…"
                >
                  Import and email the parents now
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPreview(null);
                    setFileName("");
                    setCsv("");
                  }}
                >
                  Choose another file
                </Button>
              </div>
              {preview.invites === 0 && (
                <p className="muted">Nothing to import: every row was skipped (see below).</p>
              )}
              {preview.invites > 20 && (
                <p className="muted">
                  The first 20 invitations go out straight away. The rest are sent over the next
                  hours (and days, for a long list) to stay within the daily email limit.
                </p>
              )}
              {skipped.length > 0 && (
                <>
                  <h2>Skipped rows</h2>
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users scroll the table */}
                  <section className="table-wrap" tabIndex={0} aria-label="Skipped rows">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Row in file</th>
                          <th scope="col">Family</th>
                          <th scope="col">Email</th>
                          <th scope="col">Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skipped.map((r) => (
                          <tr key={r.line}>
                            <td>{r.line}</td>
                            <td>{r.familyName || "—"}</td>
                            <td>{r.email || "—"}</td>
                            <td>{r.problem ? PROBLEMS[r.problem] : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Layout>
  );
}
