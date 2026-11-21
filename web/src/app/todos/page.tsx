"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { tabAddress } from "@/lib/coding-tabs";

// `/todos` used to be the managing page and is gone. A bookmark, an old notification link or a jump from an older client
// now lands in Coding → "Scheduled", the only part of it that lives on.
//
// Same pattern as app/skills/page.tsx: the one-shot address request `?tab=…` (lib/coding-tabs.ts `tabAddress`), which
// the coding page reads on mount. Client-side forward because the static export has no server redirects.
export default function TodosForwarding() {
  const router = useRouter();
  useEffect(() => {
    router.replace(tabAddress("scheduled"));
  }, [router]);
  return null;
}
