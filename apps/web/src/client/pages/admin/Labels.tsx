import { LABEL_TEMPLATES, type LabelTemplate, labelsPerSheet } from "@community-library/adapters";
import QRCode from "qrcode";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Layout, Loading } from "../../components.tsx";
import { api, errorMessage } from "../../lib/api.ts";
import { Link, useLocation } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.tsx";

interface Label {
  id: string;
  shortCode: string;
  title: string;
}

const TEMPLATE_KEY = "labelTemplate";
const MM_TO_PX = 96 / 25.4;

function savedTemplate(): LabelTemplate {
  let id: string | null = null;
  try {
    id = localStorage.getItem(TEMPLATE_KEY);
  } catch {
    // Private mode.
  }
  const guess =
    navigator.language.startsWith("en-US") || navigator.language.startsWith("en-CA")
      ? "letter-30"
      : "a4-21";
  return (
    LABEL_TEMPLATES.find((t) => t.id === (id ?? guess)) ?? (LABEL_TEMPLATES[0] as LabelTemplate)
  );
}

/**
 * The link inside every QR sticker, such as https://library.example.org/c/K7R2.
 * It uses the site's public address from the server (not whatever address this
 * page was opened on), and never changes, so stickers never need reprinting.
 */
export function copyUrl(siteUrl: string, shortCode: string): string {
  return `${siteUrl}/c/${shortCode}`;
}

const isTouchDevice = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

export function LabelsPage() {
  const { query } = useLocation();
  const ids = query.get("ids") ?? "";
  const { state } = useSession();
  const libraryName = state.status === "ready" ? (state.me.library?.name ?? "") : "";
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState<LabelTemplate>(savedTemplate);
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState("");
  const [printed, setPrinted] = useState<"no" | "asked" | "marking" | "done">("no");
  const [zoom, setZoom] = useState(1);
  const preview = useRef<HTMLDivElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ labels: Label[]; siteUrl: string }>(
      `/catalog/labels${ids ? `?ids=${encodeURIComponent(ids)}` : ""}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const svgs = await Promise.all(
          res.labels.map((label) =>
            QRCode.toString(copyUrl(res.siteUrl, label.shortCode), {
              type: "svg",
              margin: 0,
              errorCorrectionLevel: "M",
            }),
          ),
        );
        if (controller.signal.aborted) return;
        setQr(Object.fromEntries(res.labels.map((label, i) => [label.id, svgs[i] ?? ""])));
        setLabels(res.labels);
      })
      .catch((e) => {
        const message = errorMessage(e);
        if (message) setError(message);
      });
    return () => controller.abort();
  }, [ids]);

  // Shrink the on-screen preview to fit the screen. Printing always uses real size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: labels changes whether the preview exists
  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const fit = () => setZoom(Math.min(1, element.clientWidth / (template.page.width * MM_TO_PX)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [template, labels]);

  useEffect(() => {
    if (printed === "asked" || printed === "done") confirmBox.current?.focus();
  }, [printed]);

  const perSheet = labelsPerSheet(template);
  const sheets = useMemo(() => {
    if (!labels) return [];
    const cells: (Label | null)[] = [...Array<null>(skip).fill(null), ...labels];
    const pages: (Label | null)[][] = [];
    for (let i = 0; i < cells.length; i += perSheet) pages.push(cells.slice(i, i + perSheet));
    return pages;
  }, [labels, skip, perSheet]);

  const chooseTemplate = (id: string) => {
    const next = LABEL_TEMPLATES.find((t) => t.id === id);
    if (!next) return;
    setTemplate(next);
    setSkip(0);
    try {
      localStorage.setItem(TEMPLATE_KEY, id);
    } catch {
      // Private mode.
    }
  };

  const print = () => {
    window.print();
    setPrinted("asked");
  };

  const markPrinted = async () => {
    if (!labels) return;
    setPrinted("marking");
    try {
      await api("/catalog/labels/printed", { body: { copyIds: labels.map((l) => l.id) } });
      setPrinted("done");
    } catch (e) {
      setError(errorMessage(e));
      setPrinted("asked");
    }
  };

  const positions = Array.from({ length: perSheet }, (_, n) => n);

  return (
    <Layout title="Print labels" back="/admin">
      <div className="no-print">
        <Alert>{error}</Alert>
        {labels === null && !error && <Loading label="Preparing labels…" />}
        {labels?.length === 0 && (
          <p>
            {ids
              ? "Those copies were not found."
              : "Every copy already has a label. New copies will appear here."}
          </p>
        )}
        {labels && labels.length > 0 && (
          <div className="stack">
            <p className="lead">
              {labels.length} {labels.length === 1 ? "label" : "labels"} on {sheets.length}{" "}
              {sheets.length === 1 ? "sheet" : "sheets"}.
              {!ids && " These are the copies that have never had a label."}
            </p>
            {isTouchDevice() && (
              <Alert kind="info">
                Phones often shrink pages when printing. For labels that line up, print from a
                computer, or choose "Actual size" in your phone's print options.
              </Alert>
            )}
            <div className="field">
              <label htmlFor="template">Label paper</label>
              <p className="field__hint" id="template-hint">
                Check the label size on the packet.
              </p>
              <select
                id="template"
                aria-describedby="template-hint"
                value={template.id}
                onChange={(e) => chooseTemplate(e.target.value)}
              >
                {LABEL_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="skip">Start at label</label>
              <p className="field__hint" id="skip-hint">
                Using a sheet with some labels already peeled off? Start at the first unused one,
                counting across each row from the top left.
              </p>
              <select
                id="skip"
                aria-describedby="skip-hint"
                value={skip}
                onChange={(e) => setSkip(Number(e.target.value))}
              >
                {positions.map((position) => (
                  <option key={position} value={position}>
                    {position === 0
                      ? "1 (a fresh sheet)"
                      : `${position + 1} (row ${Math.floor(position / template.columns) + 1}, column ${(position % template.columns) + 1})`}
                  </option>
                ))}
              </select>
            </div>
            <div className="card">
              <p>
                <strong>In the print window, choose:</strong>
              </p>
              <ul>
                <li>Scale: Actual size (100%), not "Fit to page"</li>
                <li>Margins: None</li>
                <li>Headers and footers: off</li>
              </ul>
              <p className="muted">
                Not sure it will line up? Print one sheet on plain paper first and hold it against a
                label sheet.
              </p>
            </div>
            <Button className="btn--block" onClick={print}>
              Print
            </Button>
            {printed === "asked" && (
              <div className="alert alert--info" ref={confirmBox} tabIndex={-1}>
                <p style={{ margin: "0 0 0.75rem" }}>Did the labels print and line up?</p>
                <div className="row">
                  <Button onClick={markPrinted}>Yes, mark them as printed</Button>
                  <Button variant="secondary" onClick={print}>
                    No, print again
                  </Button>
                </div>
              </div>
            )}
            {printed === "marking" && <Loading label="Saving…" />}
            {printed === "done" && (
              <div className="alert alert--success" ref={confirmBox} tabIndex={-1}>
                <p style={{ margin: "0 0 0.75rem" }}>
                  Marked as printed. Stick each label inside the front cover of its book.
                </p>
                <div className="row">
                  <Link href="/admin/add" className="btn btn--primary">
                    Add more books
                  </Link>
                  <Link href="/admin" className="btn btn--secondary">
                    Back to admin
                  </Link>
                </div>
              </div>
            )}
            <h2>Preview</h2>
          </div>
        )}
      </div>
      {labels && labels.length > 0 && (
        // A picture of the sheets; the same details are in the text above.
        <div
          className="label-sheets"
          ref={preview}
          aria-hidden="true"
          style={
            {
              "--page-w": `${template.page.width}mm`,
              "--page-h": `${template.page.height}mm`,
              "--preview-zoom": zoom,
            } as CSSProperties
          }
        >
          <style>{`@page { size: ${template.page.width}mm ${template.page.height}mm; margin: 0; }`}</style>
          {sheets.map((cells, page) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sheets have no identity besides their order
            <div className="label-sheet" key={page}>
              {cells.map((cell, i) => {
                const col = i % template.columns;
                const row = Math.floor(i / template.columns);
                const style: CSSProperties = {
                  left: `${template.margin.left + col * template.pitch.x}mm`,
                  top: `${template.margin.top + row * template.pitch.y}mm`,
                  width: `${template.label.width}mm`,
                  height: `${template.label.height}mm`,
                };
                if (!cell) {
                  // biome-ignore lint/suspicious/noArrayIndexKey: skipped spaces have no identity
                  return <div className="label label--skipped" style={style} key={`skip-${i}`} />;
                }
                return (
                  <div className="label" style={style} key={cell.id}>
                    <div
                      className="label__qr"
                      // The SVG is generated locally by the qrcode library from our own URL.
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, locally generated SVG
                      dangerouslySetInnerHTML={{ __html: qr[cell.id] ?? "" }}
                    />
                    <div className="label__text">
                      <span className="label__code">{cell.shortCode}</span>
                      <span className="label__title">{cell.title}</span>
                      <span className="label__library">{libraryName}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
