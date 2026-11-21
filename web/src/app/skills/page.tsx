"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { tabAddress } from "@/lib/coding-tabs";

// `/skills` is no longer a page of its own: skills live in the left coding bar (tab "skills", components/SkillsPane.tsx). A
// bookmark or old link therefore lands in Coding → Skills via the one-shot address request `?tab=skills`
// (lib/coding-tabs.ts `tabAddress`), which the coding page reads on mount and removes from the address. It applies in the
// remembered workspace, otherwise in the first one picked, and needs no storage.
//
// Client-side forward like the start page (app/page.tsx): the static export has no server redirects.
export default function SkillsForwarding() {
  const router = useRouter();
  useEffect(() => {
    router.replace(tabAddress("skills"));
  }, [router]);
  return null;
}
