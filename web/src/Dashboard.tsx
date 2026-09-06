import { FormEvent, useEffect, useState } from "react";
import { api, isUnauthorized } from "./api";
import type { Forwarder } from "./types";

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
}

function statusLabel(status: Forwarder["status"]): string {
  if (status === "running") return "running";
  if (status === "unhealthy") return "unhealthy";
  if (status === "missing") return "missing";
  return "stopped";
}

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [forwarders, setForwarders] = useState<Forwarder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [edit, setEdit] = useState<Forwarder | null>(null);
  const [removing, setRemoving] = useState<Forwarder | null>(null);

  async function refresh() {
    try {
      const data = await api.list();
      setForwarders(data.forwarders);
      setError(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onLogout();
        return;
      }
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (isUnauthorized(err)) onLogout();
      else setError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <h1>La Poste Forwarder</h1>
        </div>
        <div className="row">
          <button className="btn btn-primary" type="button" onClick={() => setAddOpen(true)}>
            Add forwarder
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <main className="page">
        {error && <p className="banner">{error}</p>}
        {forwarders.length === 0 && !error && (
          <div className="empty">
            <h2>No forwarders yet</h2>
            <p className="muted">Add a La Poste → Gmail pair to start copying mail.</p>
          </div>
        )}
        <div className="grid">
          {forwarders.map((fwd) => (
            <article className="card" key={fwd.id}>
              <div className="card-head">
                <div className="identity">
                  <div className="id">{fwd.id}</div>
                  <div className="from">{fwd.laposteUser}</div>
                  <div className="to">→ {fwd.gmailUser}</div>
                </div>
                <span className={`pill ${fwd.status}`}>{statusLabel(fwd.status)}</span>
              </div>
              <div className="metrics">
                <div className="metric">
                  <span className="label">Latest exec</span>
                  <span className="value">{formatWhen(fwd.lastExecAt)}</span>
                </div>
                <div className="metric">
                  <span className="label">Last run</span>
                  <span className="value">
                    {fwd.lastRunTransferred === null ? "—" : `${fwd.lastRunTransferred} msgs`}
                    {fwd.lastRunOk === false ? " (failed)" : ""}
                  </span>
                </div>
                <div className="metric">
                  <span className="label">Last 24h</span>
                  <span className="value">{fwd.transferredLast24h} msgs</span>
                </div>
              </div>
              {fwd.deleteAfterForward && (
                <p className="warn">Deletes from La Poste after a confirmed copy. Gmail holds the only remaining copy.</p>
              )}
              <div className="row">
                {fwd.status === "running" || fwd.status === "unhealthy" ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busyId === fwd.id}
                    onClick={() => void act(fwd.id, () => api.stop(fwd.id))}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busyId === fwd.id}
                    onClick={() => void act(fwd.id, () => api.start(fwd.id))}
                  >
                    Start
                  </button>
                )}
                <button className="btn" type="button" onClick={() => setEdit(fwd)}>
                  Edit
                </button>
                <button className="btn btn-danger" type="button" onClick={() => setRemoving(fwd)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      </main>
      {addOpen && (
        <AddModal
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await refresh();
          }}
          onAuthLost={onLogout}
        />
      )}
      {edit && (
        <EditModal
          forwarder={edit}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await refresh();
          }}
          onAuthLost={onLogout}
        />
      )}
      {removing && (
        <ConfirmModal
          title={`Delete ${removing.id}?`}
          body="The container is removed and password files are deleted. This cannot be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            act(removing.id, async () => {
              await api.remove(removing.id);
              setRemoving(null);
            })
          }
        />
      )}
    </>
  );
}

function AddModal({
  onClose,
  onSaved,
  onAuthLost,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  onAuthLost: () => void;
}) {
  const [laposteUser, setLaposteUser] = useState("");
  const [gmailUser, setGmailUser] = useState("");
  const [lapostePassword, setLapostePassword] = useState("");
  const [gmailPassword, setGmailPassword] = useState("");
  const [deleteAfterForward, setDeleteAfterForward] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.create({
        laposteUser,
        gmailUser,
        lapostePassword,
        gmailPassword,
        deleteAfterForward,
      });
      await onSaved();
    } catch (err) {
      if (isUnauthorized(err)) onAuthLost();
      else setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Add forwarder</h2>
        <p className="muted">The La Poste address cannot be changed later.</p>
        <label className="field">
          <span>La Poste address</span>
          <input type="email" value={laposteUser} onChange={(e) => setLaposteUser(e.target.value)} required />
        </label>
        <label className="field">
          <span>Gmail address</span>
          <input type="email" value={gmailUser} onChange={(e) => setGmailUser(e.target.value)} required />
        </label>
        <label className="field">
          <span>La Poste password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={lapostePassword}
            onChange={(e) => setLapostePassword(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Gmail app password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={gmailPassword}
            onChange={(e) => setGmailPassword(e.target.value)}
            required
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={deleteAfterForward}
            onChange={(e) => setDeleteAfterForward(e.target.checked)}
          />
          <span>
            Delete from La Poste after a confirmed copy. Leave off until this account has been
            validated. Once on, Gmail holds the only remaining copy.
          </span>
        </label>
        {error && <p className="warn">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function EditModal({
  forwarder,
  onClose,
  onSaved,
  onAuthLost,
}: {
  forwarder: Forwarder;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onAuthLost: () => void;
}) {
  const [gmailUser, setGmailUser] = useState(forwarder.gmailUser);
  const [lapostePassword, setLapostePassword] = useState("");
  const [gmailPassword, setGmailPassword] = useState("");
  const [deleteAfterForward, setDeleteAfterForward] = useState(forwarder.deleteAfterForward);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (deleteAfterForward && !forwarder.deleteAfterForward && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patch(forwarder.id, {
        gmailUser,
        lapostePassword: lapostePassword || undefined,
        gmailPassword: gmailPassword || undefined,
        deleteAfterForward,
      });
      await onSaved();
    } catch (err) {
      if (isUnauthorized(err)) onAuthLost();
      else setError(err instanceof Error ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Edit {forwarder.id}</h2>
        <p className="muted">{forwarder.laposteUser}</p>
        <label className="field">
          <span>Gmail address</span>
          <input type="email" value={gmailUser} onChange={(e) => setGmailUser(e.target.value)} required />
        </label>
        <label className="field">
          <span>New La Poste password</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="leave blank to keep"
            value={lapostePassword}
            onChange={(e) => setLapostePassword(e.target.value)}
          />
        </label>
        <label className="field">
          <span>New Gmail app password</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="leave blank to keep"
            value={gmailPassword}
            onChange={(e) => setGmailPassword(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={deleteAfterForward}
            onChange={(e) => {
              setDeleteAfterForward(e.target.checked);
              setConfirmDelete(false);
            }}
          />
          <span>Delete from La Poste after a confirmed copy.</span>
        </label>
        {confirmDelete && (
          <p className="banner">
            Enabling deletion means Gmail will hold the only copy. Save again to confirm.
          </p>
        )}
        {error && <p className="warn">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : confirmDelete ? "Confirm save" : "Save"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
