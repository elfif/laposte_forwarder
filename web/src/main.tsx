import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Dashboard } from "./Dashboard";
import "./index.css";
import { Login } from "./Login";

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.me().then((res) => {
      if (!cancelled) setAuthed(res.ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (authed === null) {
    return (
      <div className="login-shell">
        <p className="muted">Checking session…</p>
      </div>
    );
  }

  if (!authed) {
    return <Login onOk={() => setAuthed(true)} />;
  }

  return <Dashboard onLogout={() => setAuthed(false)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
