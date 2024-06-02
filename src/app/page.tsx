"use client";

import { useEffect } from "react";
import { initClientInfo } from "../core/synthient-chain/db/identity-db";
export default function Home() {
  useEffect(() => {
    const clientInfo = initClientInfo("test-password").then((clientInfo) => {
      console.log("Got client info ", clientInfo);
    });
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      Welcome to Synthient!
    </main>
  );
}
