import { useCallback, useEffect, useState } from "react";
import {
  LEAD_CATEGORIES,
  type EmailDraft,
  type Lead,
  type LeadCategory
} from "./sales-types";
import type { AuditReport, ReportSummary } from "./website-analysis";

interface SalesSnapshot {
  mode: "draft_only" | "mock" | "gmail";
  outreachEnabled: boolean;
  limits: { newLeadsPerDay: number; sendsPerDay: number };
  usage: { new_leads: number; sent_messages: number };
  leads: Lead[];
  drafts: EmailDraft[];
}

function Summary({ summary }: { summary: ReportSummary }) {
  return (
    <div className="summary">
      <span className="critical">{summary.critical} kritisch</span>
      <span className="important">{summary.important} wichtig</span>
      <span className="optional">{summary.optional} optional</span>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("guardian-token") || ""
  );
  const [draftToken, setDraftToken] = useState("");
  const [accessMode, setAccessMode] = useState(
    () => sessionStorage.getItem("access-mode") === "cloudflare"
  );
  const [tab, setTab] = useState<"sales" | "guardian">("sales");
  const [sales, setSales] = useState<SalesSnapshot | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [candidate, setCandidate] = useState({
    businessName: "",
    category: "restaurant" as LeadCategory,
    city: "",
    websiteUrl: "",
    mapsUrl: "",
    publicEmail: "",
    sourceUrl: "",
    language: "fr" as "fr" | "ar"
  });

  const authenticated = accessMode || Boolean(token);

  const api = useCallback(async function requestApi<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
      const headers = new Headers(init?.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (init?.body) headers.set("content-type", "application/json");
      const response = await fetch(path, { ...init, headers });
      const payload = (await response.json()) as T & { error?: string };
      if (!response.ok)
        throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    },
    [token]
  );

  const loadSales = useCallback(async () => {
    try {
      setSales(await api<SalesSnapshot>("/api/sales"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Abruf fehlgeschlagen");
    }
  }, [api]);

  useEffect(() => {
    if (authenticated) void loadSales();
  }, [authenticated, loadSales]);

  async function action(path: string, body?: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      await loadSales();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function queueCandidate() {
    const sourceUrls = [candidate.sourceUrl || candidate.websiteUrl].filter(Boolean);
    await action("/api/discovery/queue", {
      ...candidate,
      country: "MA",
      sourceUrls,
      websiteUrl: candidate.websiteUrl || undefined,
      mapsUrl: candidate.mapsUrl || undefined,
      publicEmail: candidate.publicEmail || undefined
    });
    setCandidate({
      businessName: "",
      category: "restaurant",
      city: "",
      websiteUrl: "",
      mapsUrl: "",
      publicEmail: "",
      sourceUrl: "",
      language: "fr"
    });
  }

  if (!authenticated) {
    return (
      <main className="login">
        <section className="panel">
          <p className="eyebrow">Private Operations</p>
          <h1>ReelHaus Manager</h1>
          <p>Mit Cloudflare Access fortfahren oder lokales Token verwenden.</p>
          <button
            onClick={() => {
              sessionStorage.setItem("access-mode", "cloudflare");
              setAccessMode(true);
            }}
          >
            Cloudflare Access verwenden
          </button>
          <div className="separator">oder lokal</div>
          <label htmlFor="token">Guardian API Token</label>
          <input
            id="token"
            type="password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
          />
          <button
            className="secondary"
            disabled={!draftToken.trim()}
            onClick={() => {
              sessionStorage.setItem("guardian-token", draftToken.trim());
              setToken(draftToken.trim());
            }}
          >
            Mit Token öffnen
          </button>
        </section>
      </main>
    );
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Private Website & Sales Operations</p>
          <h1>ReelHaus Manager</h1>
          <p>Kontrollierte Recherche, Freigaben und read-only Website-Prüfung.</p>
        </div>
        <div className="actions">
          <button className={tab === "sales" ? "" : "secondary"} onClick={() => setTab("sales")}>
            Sales
          </button>
          <button className={tab === "guardian" ? "" : "secondary"} onClick={() => setTab("guardian")}>
            Guardian
          </button>
          <button
            className="secondary"
            onClick={() => {
              sessionStorage.clear();
              setToken("");
              setAccessMode(false);
            }}
          >
            Sperren
          </button>
        </div>
      </header>
      {error && <div className="error" role="alert">{error}</div>}

      {tab === "guardian" ? (
        <section className="panel">
          <div className="report-title">
            <div>
              <h2>Website Guardian</h2>
              <p>Read-only Analyse von /fr/ und /ar/.</p>
            </div>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setReport(await api<AuditReport>("/api/scan", { method: "POST" }));
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "Prüfung fehlgeschlagen");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Prüfung starten
            </button>
          </div>
          {report && (
            <>
              <Summary summary={report.summary} />
              {report.findings.map((finding, index) => (
                <article className={`finding ${finding.severity}`} key={index}>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                  <small>{finding.page} · {finding.evidence}</small>
                </article>
              ))}
            </>
          )}
        </section>
      ) : (
        <>
          <section className="metrics">
            <div className="panel"><strong>{sales?.leads.length || 0}</strong><span>Leads</span></div>
            <div className="panel"><strong>{sales?.usage.new_leads || 0}/{sales?.limits.newLeadsPerDay || 20}</strong><span>Heute recherchiert</span></div>
            <div className="panel"><strong>{sales?.usage.sent_messages || 0}/{sales?.limits.sendsPerDay || 5}</strong><span>Heute versendet</span></div>
            <div className="panel"><strong>{sales?.mode || "draft_only"}</strong><span>E-Mail-Modus</span></div>
          </section>

          <section className="panel">
            <h2>Öffentlichen Betrieb vormerken</h2>
            <p className="muted">Nur öffentlich verifizierbare Geschäftsdaten eingeben. Der Cron verarbeitet die Queue innerhalb des Tageslimits.</p>
            <div className="form-grid">
              <input placeholder="Geschäftsname" value={candidate.businessName} onChange={(e) => setCandidate({ ...candidate, businessName: e.target.value })} />
              <select value={candidate.category} onChange={(e) => setCandidate({ ...candidate, category: e.target.value as LeadCategory })}>
                {LEAD_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
              </select>
              <input placeholder="Stadt" value={candidate.city} onChange={(e) => setCandidate({ ...candidate, city: e.target.value })} />
              <select value={candidate.language} onChange={(e) => setCandidate({ ...candidate, language: e.target.value as "fr" | "ar" })}>
                <option value="fr">Französisch</option><option value="ar">Arabisch</option>
              </select>
              <input placeholder="Öffentliche Website" value={candidate.websiteUrl} onChange={(e) => setCandidate({ ...candidate, websiteUrl: e.target.value })} />
              <input placeholder="Maps-Link (optional)" value={candidate.mapsUrl} onChange={(e) => setCandidate({ ...candidate, mapsUrl: e.target.value })} />
              <input placeholder="Öffentliche Geschäfts-E-Mail" value={candidate.publicEmail} onChange={(e) => setCandidate({ ...candidate, publicEmail: e.target.value })} />
              <input placeholder="Quell-URL" value={candidate.sourceUrl} onChange={(e) => setCandidate({ ...candidate, sourceUrl: e.target.value })} />
            </div>
            <div className="actions">
              <button disabled={busy || !candidate.businessName || !candidate.city || (!candidate.sourceUrl && !candidate.websiteUrl)} onClick={queueCandidate}>
                Zur Recherche-Queue
              </button>
              <button className="secondary" disabled={busy} onClick={() => action("/api/discovery/run")}>
                Queue jetzt prüfen
              </button>
            </div>
          </section>

          <div className="sales-layout">
            <section className="panel">
              <h2>Leads</h2>
              {sales?.leads.map((lead) => (
                <article className="lead" key={lead.id}>
                  <div className="finding-head">
                    <div><strong>{lead.businessName}</strong><small>{lead.category} · {lead.city}</small></div>
                    <span className="score">{lead.score}</span>
                  </div>
                  <p>{lead.publicEmail || "Keine öffentliche E-Mail"} · {lead.status}</p>
                  <div className="chips">{lead.observedIssues.map((issue) => <span key={issue.code}>{issue.detail}</span>)}</div>
                  <div className="actions">
                    <button disabled={busy || !lead.publicEmail || lead.doNotContact} onClick={() => action(`/api/leads/${lead.id}/draft`, { language: lead.language, kind: "initial" })}>Entwurf</button>
                    <button className="danger" disabled={busy || lead.doNotContact} onClick={() => action(`/api/leads/${lead.id}/do-not-contact`)}>Do not contact</button>
                  </div>
                </article>
              ))}
            </section>
            <section className="panel">
              <h2>E-Mail-Entwürfe</h2>
              {sales?.drafts.map((draft) => (
                <DraftEditor
                  key={draft.id}
                  draft={draft}
                  busy={busy}
                  action={action}
                  mode={sales.mode}
                  outreachEnabled={sales.outreachEnabled}
                />
              ))}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function DraftEditor({
  draft,
  busy,
  action,
  mode,
  outreachEnabled
}: {
  draft: EmailDraft;
  busy: boolean;
  mode: SalesSnapshot["mode"];
  outreachEnabled: boolean;
  action: (path: string, body?: unknown, method?: string) => Promise<void>;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.subject, draft.body]);
  return (
    <article className="draft">
      <div className="finding-head"><strong>{draft.kind}</strong><span>{draft.status} · v{draft.version}</span></div>
      <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={draft.status === "sent"} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={draft.status === "sent"} rows={13} />
      <div className="actions">
        <button className="secondary" disabled={busy || draft.status === "sent"} onClick={() => action(`/api/drafts/${draft.id}`, { subject, body }, "PATCH")}>Edit speichern</button>
        <button disabled={busy || draft.status !== "draft_ready"} onClick={() => action(`/api/drafts/${draft.id}/approve`)}>Approve</button>
        <button className="danger" disabled={busy || draft.status === "sent"} onClick={() => action(`/api/drafts/${draft.id}/reject`)}>Reject</button>
        {draft.status === "approved" &&
          mode !== "draft_only" &&
          outreachEnabled && (
          <button disabled={busy} onClick={() => action(`/api/drafts/${draft.id}/send`)}>Einmal senden</button>
        )}
      </div>
    </article>
  );
}
