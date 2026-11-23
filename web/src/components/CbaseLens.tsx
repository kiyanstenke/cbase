// The cbase mark inside the app (header, boot splash, gateway login) — never the app-icon tile.
//
// The source is drawn for a dark ground (light letter, blue square); on a light ground the letter would vanish. So the mark comes as
// two files from tools/icon/build-icons.mjs, and CSS shows the one that fits `data-theme` (globals.css, `.cb-lens-on-*`). Both images
// sit in the markup, so a theme switch needs no reload and the boot splash shows the right one from the first frame (the theme is set
// before first paint, layout.tsx).

export function CbaseLens({ className = "", alt = "" }: { className?: string; alt?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no next/image in a static export */}
      <img src="/cbase-lens-ink.png" alt={alt} className={`cb-lens-on-light ${className}`} />
      {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no next/image in a static export */}
      <img src="/cbase-lens.png" alt={alt} className={`cb-lens-on-dark ${className}`} />
    </>
  );
}
