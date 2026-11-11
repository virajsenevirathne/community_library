import { useState } from "react";

/**
 * A book cover, or a plain coloured placeholder with the title's first letter
 * when there is no image (or it fails to load). Decorative: the title is
 * always shown as text nearby.
 */
export function Cover({
  url,
  title,
  size = "md",
}: {
  url: string | null;
  title: string;
  size?: "sm" | "md" | "lg";
}) {
  // Remember a failed image per URL, so a new cover gets its own chance to load.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === url;
  if (url && !failed) {
    return (
      <img
        className={`cover cover--${size}`}
        src={url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <span className={`cover cover--${size} cover--placeholder`} aria-hidden="true">
      {title.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
