import { useEffect, useState } from "react";
import { pingCore } from "./lib/ping";

export function App() {
  const [status, setStatus] = useState("contacting core…");

  useEffect(() => {
    pingCore().then(setStatus, (err: unknown) => setStatus(`core unreachable: ${String(err)}`));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>task-master</h1>
      <p data-testid="core-status">{status}</p>
    </main>
  );
}
