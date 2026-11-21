"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Chats live as tabs in the workspace — the start page shows the workspaces.
// Client redirect, because the static export knows no server redirects.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/workspaces");
  }, [router]);
  return null;
}
