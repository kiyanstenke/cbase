"use client";

// The two icons of the dumpster composer (workspaces/page.tsx).

export function DumpsterSendIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m2 8 12-5-4.5 10-2-4-5.5-1Z"/><path d="m7.5 9 3-3"/></svg>;
}
export function DumpsterSpinner() {
  return <svg className="animate-spin" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden><circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity=".3" strokeWidth="2"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}
