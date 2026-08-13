import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LEAD_CATEGORIES,
  LEAD_STATUSES,
  type Activity,
  type BusinessAssistantOutput,
  type DiscoveryCandidate,
  type EmailDraft,
  type EmailReview,
  type Lead,
  type LeadCategory,
  type LeadQualityReview,
  type LeadStatus,
  type QualificationResult,
  type ReelScanLeadAudit
} from "./sales-types";
import type { AuditReport, ReportSummary } from "./website-analysis";
import { BusinessWorkspaceView } from "./business-workspace-view";
import { Icon, type IconName } from "./ui-icons";

interface SalesSnapshot {
  aiVersion: string;
  discovery: {
    version: string;
    candidates: DiscoveryCandidate[];
    counts: Record<string, number>;
    metrics: {
      newToday: number;
      queued: number;
      scanned: number;
      approved: number;
      rejected: number;
      ignored: number;
      duplicatesSkipped: number;
    };
    automaticQualification: false;
    qualificationRecommendationAfterScan: true;
    automaticCrmEntry: false;
    emailActionEnabled: false;
  };
  mode: "draft_only" | "mock" | "gmail";
  outreachEnabled: boolean;
  limits: { newLeadsPerDay: number; sendsPerDay: number };
  usage: { new_leads: number; sent_messages: number };
  metrics: {
    leadsFound: number;
    analyzed: number;
    qualified: number;
    draftsWaiting: number;
    actionsNeeded: number;
  };
  pilotMetrics: {
    pilotLeads: number;
    reviewed: number;
    realOpportunities: number;
    observationAccuracy: number;
    emailPersonalization: number;
    scoreUsefulness: number;
    relevance: number;
  };
  aiQuality: {
    averageObservationQuality: number;
    averagePersonalization: number;
    rejectedDrafts: number;
    missingEvidence: number;
  };
  leads: Lead[];
  drafts: EmailDraft[];
  audits: ReelScanLeadAudit[];
  qualifications: QualificationResult[];
  emailReviews: EmailReview[];
  qualityReviews: LeadQualityReview[];
  activities: Activity[];
}

type View =
  | "overview"
  | "workspace"
  | "discovery"
  | "leads"
  | "audits"
  | "email-review"
  | "pipeline"
  | "settings"
  | "guardian";

const VIEW_META: Record<
  View,
  {
    label: string;
    shortLabel: string;
    description: string;
    icon: IconName;
    group: string;
  }
> = {
  overview: {
    label: "Overview",
    shortLabel: "Overview",
    description: "Prioritäten, Pipeline und Systemgesundheit",
    icon: "overview",
    group: "Workspace"
  },
  workspace: {
    label: "Business Workspace",
    shortLabel: "Businesses",
    description: "Das vollständige Profil jedes Betriebs",
    icon: "business",
    group: "Workspace"
  },
  discovery: {
    label: "Discovery Queue",
    shortLabel: "Discovery",
    description: "Öffentliche Kandidaten kontrolliert prüfen",
    icon: "discovery",
    group: "Intelligence"
  },
  leads: {
    label: "Lead Directory",
    shortLabel: "Leads",
    description: "Qualifizierte Betriebe und Pilotdaten",
    icon: "target",
    group: "Intelligence"
  },
  audits: {
    label: "ReelScan Reports",
    shortLabel: "ReelScan",
    description: "Gastronomie-Intelligence mit verifizierter Evidenz",
    icon: "scan",
    group: "Intelligence"
  },
  guardian: {
    label: "Website Guardian",
    shortLabel: "Website Guardian",
    description: "Read-only Website-Gesundheit für ReelHaus",
    icon: "guardian",
    group: "Intelligence"
  },
  "email-review": {
    label: "Email Review",
    shortLabel: "Email Review",
    description: "Personalisierte Entwürfe vor jeder Freigabe",
    icon: "mail",
    group: "Operations"
  },
  pipeline: {
    label: "CRM Pipeline",
    shortLabel: "CRM",
    description: "Kontakte, Phasen und nächste Schritte",
    icon: "crm",
    group: "Operations"
  },
  settings: {
    label: "Settings",
    shortLabel: "Settings",
    description: "Sicherheits- und Systemkonfiguration",
    icon: "settings",
    group: "System"
  }
};

const NAV_GROUPS: Array<{ label: string; views: View[] }> = [
  { label: "Workspace", views: ["overview", "workspace"] },
  {
    label: "Intelligence",
    views: ["discovery", "leads", "audits", "guardian"]
  },
  { label: "Operations", views: ["email-review", "pipeline"] },
  { label: "System", views: ["settings"] }
];

type AccessErrorCode =
  | "ACCESS_NOT_CONFIGURED"
  | "ACCESS_LOGIN_REQUIRED"
  | "ACCESS_JWT_REJECTED";

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

function accessMessage(code: AccessErrorCode | null) {
  if (code === "ACCESS_NOT_CONFIGURED")
    return {
      title: "Cloudflare Access ist nicht konfiguriert",
      detail:
        "Die sichere Team-Domain oder die Application Audience fehlt noch."
    };
  if (code === "ACCESS_JWT_REJECTED")
    return {
      title: "Cloudflare-Access-Token abgelehnt",
      detail:
        "Die Anmeldung wurde erkannt, das Access-JWT gehört aber nicht zu dieser Anwendung."
    };
  return {
    title: "Nicht über Cloudflare Access angemeldet",
    detail:
      "Lade die Seite neu und melde dich über die private Cloudflare-Access-Seite an."
  };
}

function discoveryStatusLabel(status: DiscoveryCandidate["status"]): string {
  return {
    new: "New",
    queued: "Queued",
    analyzing: "Analyzing",
    scanned: "Scanned",
    approved: "Approved",
    sent_to_reelscan: "Sent to ReelScan",
    rejected: "Rejected",
    ignored: "Ignored",
    qualified: "Qualified"
  }[status];
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

function Empty({ children }: { children: string }) {
  return <p className="muted empty-state">{children}</p>;
}

export default function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("guardian-token") || ""
  );
  const [draftToken, setDraftToken] = useState("");
  const [authState, setAuthState] = useState<"checking" | "ready" | "blocked">(
    "checking"
  );
  const [accessError, setAccessError] = useState<AccessErrorCode | null>(null);
  const [view, setView] = useState<View>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const globalSearchRef = useRef<HTMLInputElement>(null);
  const [sales, setSales] = useState<SalesSnapshot | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [assistantOutput, setAssistantOutput] =
    useState<BusinessAssistantOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    city: "",
    category: "",
    status: "",
    minimumScore: "0"
  });
  const [candidate, setCandidate] = useState({
    businessName: "",
    category: "restaurant" as LeadCategory,
    city: "",
    websiteUrl: "",
    mapsUrl: "",
    publicEmail: "",
    phone: "",
    whatsapp: "",
    socialLinks: "",
    bookingLinks: "",
    latitude: "",
    longitude: "",
    sourceUrl: "",
    language: "fr" as "fr" | "ar",
    pilot: false
  });

  const api = useCallback(
    async function requestApi<T>(path: string, init?: RequestInit): Promise<T> {
      const headers = new Headers(init?.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (init?.body) headers.set("content-type", "application/json");
      const response = await fetch(path, {
        ...init,
        headers,
        credentials: "same-origin"
      });
      const payload = (await response.json()) as T & {
        code?: string;
        error?: string;
      };
      if (!response.ok)
        throw new ApiRequestError(
          payload.error || `HTTP ${response.status}`,
          response.status,
          payload.code
        );
      return payload;
    },
    [token]
  );

  const loadSales = useCallback(async () => {
    try {
      setSales(await api<SalesSnapshot>("/api/sales"));
      setAuthState("ready");
      setAccessError(null);
      setError("");
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 401) {
        setSales(null);
        setAuthState("blocked");
        setAccessError(
          caught.code === "ACCESS_NOT_CONFIGURED" ||
            caught.code === "ACCESS_LOGIN_REQUIRED" ||
            caught.code === "ACCESS_JWT_REJECTED"
            ? caught.code
            : "ACCESS_LOGIN_REQUIRED"
        );
        setError("");
      } else {
        setAuthState("ready");
        setError(
          caught instanceof Error ? caught.message : "Abruf fehlgeschlagen"
        );
      }
    }
  }, [api]);

  useEffect(() => {
    void loadSales();
  }, [loadSales]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        globalSearchRef.current?.focus();
      } else if (event.key === "/" && !isTyping) {
        event.preventDefault();
        globalSearchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  function openView(nextView: View) {
    setView(nextView);
    setSidebarOpen(false);
  }

  async function action<T = unknown>(
    path: string,
    body?: unknown,
    method = "POST"
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const result = await api<T>(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      await loadSales();
      return result;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Aktion fehlgeschlagen"
      );
    } finally {
      setBusy(false);
    }
  }

  async function queueCandidate() {
    const sourceUrls = [candidate.sourceUrl || candidate.websiteUrl].filter(
      Boolean
    );
    await action("/api/discovery/queue", {
      ...candidate,
      country: "MA",
      sourceUrls,
      websiteUrl: candidate.websiteUrl || undefined,
      mapsUrl: candidate.mapsUrl || undefined,
      publicEmail: candidate.publicEmail || undefined,
      phone: candidate.phone || undefined,
      whatsapp: candidate.whatsapp || undefined,
      socialLinks: candidate.socialLinks
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      bookingLinks: candidate.bookingLinks
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      languagesDetected: [candidate.language],
      latitude: candidate.latitude ? Number(candidate.latitude) : undefined,
      longitude: candidate.longitude ? Number(candidate.longitude) : undefined,
      discoverySource: candidate.sourceUrl || candidate.websiteUrl || undefined
    });
    const keepPilotMode = candidate.pilot;
    setCandidate({
      businessName: "",
      category: "restaurant",
      city: "",
      websiteUrl: "",
      mapsUrl: "",
      publicEmail: "",
      phone: "",
      whatsapp: "",
      socialLinks: "",
      bookingLinks: "",
      latitude: "",
      longitude: "",
      sourceUrl: "",
      language: "fr",
      pilot: keepPilotMode
    });
  }

  async function downloadReelScan(format: "csv" | "json") {
    setBusy(true);
    setError("");
    try {
      const headers = new Headers();
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(`/api/reelscan/export?format=${format}`, {
        headers,
        credentials: "same-origin"
      });
      if (!response.ok)
        throw new Error(`Export fehlgeschlagen: HTTP ${response.status}`);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `reelscan-reports.${format}`;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Export fehlgeschlagen"
      );
    } finally {
      setBusy(false);
    }
  }

  const filteredLeads = useMemo(
    () =>
      (sales?.leads || []).filter(
        (lead) =>
          (!filters.city ||
            lead.city.toLowerCase().includes(filters.city.toLowerCase())) &&
          (!filters.category || lead.category === filters.category) &&
          (!filters.status || lead.status === filters.status) &&
          (sales?.qualifications.find((item) => item.leadId === lead.id)
            ?.opportunityScore || 0) >= Number(filters.minimumScore || 0)
      ),
    [filters, sales]
  );

  if (authState !== "ready") {
    const problem = accessMessage(accessError);
    return (
      <main className="login">
        <section className="panel">
          <p className="eyebrow">Private Operations</p>
          <h1>ReelHaus Manager</h1>
          {authState === "checking" ? (
            <p>Zugriff wird sicher geprüft…</p>
          ) : (
            <>
              <div className="error" role="alert">
                <strong>{problem.title}</strong>
                <p>{problem.detail}</p>
              </div>
              <button onClick={() => window.location.reload()}>
                Neu laden / sicher anmelden
              </button>
            </>
          )}
          {import.meta.env.DEV && (
            <>
              <div className="separator">nur lokale Entwicklung</div>
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
                  setAuthState("checking");
                }}
              >
                Lokales Token verwenden
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <button
        aria-label="Navigation schließen"
        className="sidebar-scrim"
        onClick={() => setSidebarOpen(false)}
      />
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <div>
            <strong>ReelHaus</strong>
            <span>Manager</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Manager-Bereiche">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.views.map((id) => (
                <button
                  aria-current={view === id ? "page" : undefined}
                  className={view === id ? "active" : ""}
                  key={id}
                  onClick={() => openView(id)}
                >
                  <Icon name={VIEW_META[id].icon} />
                  <span>{VIEW_META[id].shortLabel}</span>
                  {id === "email-review" &&
                    Boolean(sales?.metrics.draftsWaiting) && (
                      <small>{sales?.metrics.draftsWaiting}</small>
                    )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-safe-state">
            <span className="status-dot" />
            <div>
              <strong>Safe mode active</strong>
              <span>{sales?.mode || "mock"} · Outreach off</span>
            </div>
          </div>
          <button
            className="sidebar-lock"
            onClick={() => {
              sessionStorage.removeItem("guardian-token");
              setToken("");
              setSales(null);
              setAuthState("checking");
              window.location.reload();
            }}
          >
            <Icon name="lock" />
            <span>Workspace sperren</span>
          </button>
        </div>
      </aside>

      <div className="app-surface">
        <header className="topbar">
          <button
            aria-label="Navigation öffnen"
            className="mobile-menu"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="page-context">
            <strong>{VIEW_META[view].label}</strong>
            <span>{VIEW_META[view].description}</span>
          </div>
          <div className="global-search">
            <Icon name="search" />
            <input
              aria-label="Globale Business-Suche"
              onChange={(event) => setGlobalSearch(event.target.value)}
              onFocus={() => {
                if (view !== "workspace") openView("workspace");
              }}
              placeholder="Betriebe durchsuchen…"
              ref={globalSearchRef}
              type="search"
              value={globalSearch}
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-meta">
            <span className="environment-pill">Production</span>
            <span className="version-pill">
              AI v{sales?.aiVersion || "1.0"}
            </span>
            <span className="safe-pill">
              <span />
              Safe
            </span>
            <button
              className="icon-button"
              aria-label="Benachrichtigungen – demnächst"
            >
              <Icon name="bell" />
            </button>
            <div className="user-chip" title="Workspace owner">
              <span>BR</span>
              <div>
                <strong>Badr</strong>
                <small>Owner</small>
              </div>
            </div>
          </div>
        </header>

        <main className="app-content">
          <div className="mobile-page-heading">
            <p className="eyebrow">ReelHaus Manager</p>
            <h1>{VIEW_META[view].label}</h1>
            <p>{VIEW_META[view].description}</p>
          </div>

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          {view === "overview" && (
            <div className="overview-page">
              <section className="overview-hero">
                <div className="hero-copy">
                  <span className="hero-icon">
                    <Icon name="sparkles" />
                  </span>
                  <p className="eyebrow">ReelHaus Operations</p>
                  <h1>Guten Tag, Badr.</h1>
                  <p>
                    Dein sicherer Überblick über Discovery,
                    Gastronomie-Intelligence und die nächsten Entscheidungen.
                  </p>
                  <div className="hero-actions">
                    <button onClick={() => openView("workspace")}>
                      Business öffnen <Icon name="arrow" />
                    </button>
                    <button
                      className="secondary"
                      onClick={() => openView("discovery")}
                    >
                      Discovery prüfen
                    </button>
                  </div>
                </div>
                <div className="hero-signal">
                  <span>
                    <i /> System operational
                  </span>
                  <strong>{sales?.metrics.actionsNeeded || 0}</strong>
                  <p>Entscheidungen warten auf deine Aufmerksamkeit</p>
                  <small>Keine externe Aktion ohne Freigabe</small>
                </div>
              </section>

              <section className="metric-grid" aria-label="Key metrics">
                {[
                  [
                    sales?.metrics.leadsFound || 0,
                    "Leads gefunden",
                    "discovery" as IconName,
                    `${sales?.discovery.metrics.newToday || 0} heute`
                  ],
                  [
                    sales?.metrics.analyzed || 0,
                    "Websites analysiert",
                    "scan" as IconName,
                    "Evidence first"
                  ],
                  [
                    sales?.metrics.qualified || 0,
                    "Qualifiziert",
                    "target" as IconName,
                    "nach Evidenz-Gate"
                  ],
                  [
                    sales?.metrics.draftsWaiting || 0,
                    "Entwürfe warten",
                    "mail" as IconName,
                    "manuelle Freigabe"
                  ]
                ].map(([value, label, icon, helper]) => (
                  <article className="metric-card" key={label as string}>
                    <span className="metric-icon">
                      <Icon name={icon as IconName} />
                    </span>
                    <div>
                      <strong>{value}</strong>
                      <span>{label}</span>
                    </div>
                    <small>{helper}</small>
                  </article>
                ))}
              </section>

              <div className="overview-main-grid">
                <section className="panel priorities-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Heute</p>
                      <h2>Prioritäten</h2>
                    </div>
                    <span className="section-count">
                      {sales?.metrics.actionsNeeded || 0} offen
                    </span>
                  </div>
                  {[
                    {
                      icon: "discovery" as IconName,
                      title: `${sales?.discovery.metrics.queued || 0} Kandidaten prüfen`,
                      text: "Discovery Queue nach Relevanz und öffentlicher Evidenz sichten.",
                      target: "discovery" as View
                    },
                    {
                      icon: "mail" as IconName,
                      title: `${sales?.metrics.draftsWaiting || 0} Entwürfe reviewen`,
                      text: "Personalisierung und Beobachtungen vor der Freigabe prüfen.",
                      target: "email-review" as View
                    },
                    {
                      icon: "guardian" as IconName,
                      title: "ReelHaus Website schützen",
                      text: "FR- und AR-Version read-only auf neue Probleme prüfen.",
                      target: "guardian" as View
                    }
                  ].map((item) => (
                    <button
                      className="priority-row"
                      key={item.title}
                      onClick={() => openView(item.target)}
                    >
                      <span>
                        <Icon name={item.icon} />
                      </span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.text}</small>
                      </div>
                      <Icon name="arrow" />
                    </button>
                  ))}
                </section>

                <section className="panel pipeline-summary-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">CRM</p>
                      <h2>Pipeline</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => openView("pipeline")}
                    >
                      Alle ansehen
                    </button>
                  </div>
                  <div className="pipeline-summary-list">
                    {LEAD_STATUSES.filter((status) =>
                      [
                        "discovered",
                        "qualified",
                        "draft_ready",
                        "approved",
                        "contacted"
                      ].includes(status)
                    ).map((status) => {
                      const count = (sales?.leads || []).filter(
                        (lead) => lead.status === status
                      ).length;
                      const maximum = Math.max(
                        sales?.metrics.leadsFound || 1,
                        1
                      );
                      return (
                        <div key={status}>
                          <span>
                            <strong>{status.replaceAll("_", " ")}</strong>
                            <b>{count}</b>
                          </span>
                          <i>
                            <em
                              style={{
                                width: `${Math.max((count / maximum) * 100, count ? 5 : 0)}%`
                              }}
                            />
                          </i>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              <div className="overview-secondary-grid">
                <section className="panel activity-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Live history</p>
                      <h2>Letzte Aktivitäten</h2>
                    </div>
                    <Icon name="activity" />
                  </div>
                  <div className="activity-feed">
                    {(sales?.activities || []).slice(0, 6).map((activity) => (
                      <div className="activity" key={activity.id}>
                        <span className="activity-dot" />
                        <div>
                          <strong>{activity.action}</strong>
                          <span>{activity.actor}</span>
                        </div>
                        <time>
                          {new Date(activity.createdAt).toLocaleString()}
                        </time>
                      </div>
                    ))}
                    {!sales?.activities.length && (
                      <Empty>Noch keine Aktivität gespeichert.</Empty>
                    )}
                  </div>
                </section>

                <section className="panel quality-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Master Intelligence</p>
                      <h2>AI Quality</h2>
                    </div>
                    <span className="safe-label">
                      v{sales?.aiVersion || "1.0"}
                    </span>
                  </div>
                  <div className="quality-score-pair">
                    <div>
                      <strong>
                        {sales?.aiQuality.averageObservationQuality || 0}
                      </strong>
                      <span>/5 Beobachtung</span>
                    </div>
                    <div>
                      <strong>
                        {sales?.aiQuality.averagePersonalization || 0}
                      </strong>
                      <span>/5 Personalisierung</span>
                    </div>
                  </div>
                  <div className="quality-flags">
                    <span>
                      <b>{sales?.aiQuality.rejectedDrafts || 0}</b> abgelehnt
                    </span>
                    <span>
                      <b>{sales?.aiQuality.missingEvidence || 0}</b> Evidenz
                      fehlt
                    </span>
                  </div>
                </section>

                <section className="panel health-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Infrastructure</p>
                      <h2>System Health</h2>
                    </div>
                    <Icon name="shield" />
                  </div>
                  <ul>
                    <li>
                      <span>
                        <i className="healthy" />
                        Cloudflare Access
                      </span>
                      <strong>Protected</strong>
                    </li>
                    <li>
                      <span>
                        <i className="healthy" />
                        Email provider
                      </span>
                      <strong>{sales?.mode || "mock"}</strong>
                    </li>
                    <li>
                      <span>
                        <i className="healthy" />
                        Automatic outreach
                      </span>
                      <strong>Disabled</strong>
                    </li>
                    <li>
                      <span>
                        <i className="healthy" />
                        Daily discovery
                      </span>
                      <strong>
                        {sales?.usage.new_leads || 0}/
                        {sales?.limits.newLeadsPerDay || 20}
                      </strong>
                    </li>
                  </ul>
                </section>
              </div>
            </div>
          )}

          {view === "workspace" && (
            <BusinessWorkspaceView
              request={api}
              action={action}
              busy={busy}
              initialQuery={globalSearch}
            />
          )}

          {view === "discovery" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">
                    Autonomous Discovery Agent v
                    {sales?.discovery.version || "1.0"}
                  </p>
                  <h2>Discovery Queue</h2>
                  <p className="muted">
                    Nur öffentliche Kandidaten. Keine automatische Qualifikation
                    und keine E-Mail-Aktion.
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => action("/api/discovery/run")}
                >
                  Recherche-Queue prüfen
                </button>
              </div>
              <div
                className="discovery-summary"
                aria-label="Discovery status summary"
              >
                {[
                  [sales?.discovery.metrics.newToday || 0, "New today"],
                  [sales?.discovery.metrics.queued || 0, "Queued"],
                  [sales?.discovery.metrics.scanned || 0, "Scanned"],
                  [sales?.discovery.metrics.approved || 0, "Approved"],
                  [sales?.discovery.metrics.rejected || 0, "Rejected"],
                  [
                    sales?.discovery.metrics.duplicatesSkipped || 0,
                    "Duplicates skipped"
                  ]
                ].map(([value, label]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="table-wrap">
                <table className="discovery-table">
                  <thead>
                    <tr>
                      <th>Business</th>
                      <th>City</th>
                      <th>Category</th>
                      <th>Website</th>
                      <th>Confidence</th>
                      <th>Priority</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(sales?.discovery.candidates || [])]
                      .sort(
                        (first, second) =>
                          second.priorityScore - first.priorityScore
                      )
                      .map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.businessName}</strong>
                            {!!item.languagesDetected?.length && (
                              <small className="candidate-meta">
                                Languages: {item.languagesDetected.join(", ")}
                              </small>
                            )}
                            {item.rejectionReason && (
                              <small className="rejection-reason">
                                {item.rejectionReason}
                              </small>
                            )}
                          </td>
                          <td>{item.city}</td>
                          <td>{item.category}</td>
                          <td>
                            {item.websiteUrl ? (
                              <a
                                href={item.websiteUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Website
                              </a>
                            ) : (
                              <span className="muted">Keine</span>
                            )}
                          </td>
                          <td>{item.confidence}</td>
                          <td>
                            <strong>{item.priorityScore}/100</strong>
                            <details className="priority-details">
                              <summary>Why</summary>
                              <ul>
                                {item.priorityReasons.map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            </details>
                          </td>
                          <td>
                            <span className={`discovery-status ${item.status}`}>
                              {discoveryStatusLabel(item.status)}
                            </span>
                          </td>
                          <td>
                            <div className="candidate-actions">
                              {["new", "queued"].includes(item.status) && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    action(
                                      `/api/discovery/candidates/${item.id}/scan`,
                                      {}
                                    )
                                  }
                                >
                                  Scan now
                                </button>
                              )}
                              {item.status === "scanned" && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    action(
                                      `/api/discovery/candidates/${item.id}/decision`,
                                      { decision: "approved" }
                                    )
                                  }
                                >
                                  Approve → CRM
                                </button>
                              )}
                              {["new", "queued", "scanned"].includes(
                                item.status
                              ) && (
                                <>
                                  <button
                                    className="danger"
                                    disabled={busy}
                                    onClick={() =>
                                      action(
                                        `/api/discovery/candidates/${item.id}/decision`,
                                        { decision: "rejected" }
                                      )
                                    }
                                  >
                                    Reject
                                  </button>
                                  <button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      action(
                                        `/api/discovery/candidates/${item.id}/decision`,
                                        { decision: "ignored" }
                                      )
                                    }
                                  >
                                    Ignore
                                  </button>
                                </>
                              )}
                              {["scanned", "approved"].includes(item.status) &&
                                item.leadId && (
                                  <button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          "Diesen Betrieb ausdrücklich erneut scannen?"
                                        )
                                      )
                                        void action(
                                          `/api/discovery/candidates/${item.id}/scan`,
                                          { force: true }
                                        );
                                    }}
                                  >
                                    Rescan
                                  </button>
                                )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!sales?.discovery.candidates.length && (
                <Empty>Noch keine Discovery-Kandidaten.</Empty>
              )}
            </section>
          )}

          {view === "leads" && (
            <>
              <section className="panel">
                <h2>Öffentlichen Betrieb vormerken</h2>
                <p className="muted">
                  Ausschließlich öffentliche Geschäftsdaten und deren Quelle
                  eintragen. Die Recherche-Queue sendet keine Nachricht.
                </p>
                <div className="form-grid">
                  <Field label="Geschäftsname" id="candidate-name">
                    <input
                      id="candidate-name"
                      value={candidate.businessName}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          businessName: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Kategorie" id="candidate-category">
                    <select
                      id="candidate-category"
                      value={candidate.category}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          category: event.target.value as LeadCategory
                        })
                      }
                    >
                      {LEAD_CATEGORIES.map((category) => (
                        <option key={category}>{category}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Stadt" id="candidate-city">
                    <input
                      id="candidate-city"
                      value={candidate.city}
                      onChange={(event) =>
                        setCandidate({ ...candidate, city: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Sprache" id="candidate-language">
                    <select
                      id="candidate-language"
                      value={candidate.language}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          language: event.target.value as "fr" | "ar"
                        })
                      }
                    >
                      <option value="fr">Französisch</option>
                      <option value="ar">Arabisch</option>
                    </select>
                  </Field>
                  <Field label="Öffentliche Website" id="candidate-website">
                    <input
                      id="candidate-website"
                      type="url"
                      value={candidate.websiteUrl}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          websiteUrl: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Maps-Link" id="candidate-maps">
                    <input
                      id="candidate-maps"
                      type="url"
                      value={candidate.mapsUrl}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          mapsUrl: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Öffentliche Geschäfts-E-Mail"
                    id="candidate-email"
                  >
                    <input
                      id="candidate-email"
                      type="email"
                      value={candidate.publicEmail}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          publicEmail: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Öffentliche Telefonnummer" id="candidate-phone">
                    <input
                      id="candidate-phone"
                      value={candidate.phone}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          phone: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Öffentliches WhatsApp" id="candidate-whatsapp">
                    <input
                      id="candidate-whatsapp"
                      value={candidate.whatsapp}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          whatsapp: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Social-Links (kommagetrennt)"
                    id="candidate-social"
                  >
                    <input
                      id="candidate-social"
                      value={candidate.socialLinks}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          socialLinks: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Booking-Links (kommagetrennt)"
                    id="candidate-booking"
                  >
                    <input
                      id="candidate-booking"
                      value={candidate.bookingLinks}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          bookingLinks: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Breitengrad (optional)" id="candidate-latitude">
                    <input
                      id="candidate-latitude"
                      type="number"
                      min="-90"
                      max="90"
                      step="any"
                      value={candidate.latitude}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          latitude: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Längengrad (optional)" id="candidate-longitude">
                    <input
                      id="candidate-longitude"
                      type="number"
                      min="-180"
                      max="180"
                      step="any"
                      value={candidate.longitude}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          longitude: event.target.value
                        })
                      }
                    />
                  </Field>
                  <Field label="Quell-URL" id="candidate-source">
                    <input
                      id="candidate-source"
                      type="url"
                      value={candidate.sourceUrl}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          sourceUrl: event.target.value
                        })
                      }
                    />
                  </Field>
                  <div className="checkbox-field">
                    <input
                      id="candidate-pilot"
                      type="checkbox"
                      checked={candidate.pilot}
                      onChange={(event) =>
                        setCandidate({
                          ...candidate,
                          pilot: event.target.checked
                        })
                      }
                    />
                    <label htmlFor="candidate-pilot">
                      Als realen Pilot-Lead kennzeichnen
                    </label>
                  </div>
                </div>
                <div className="actions">
                  <button
                    disabled={
                      busy ||
                      !candidate.businessName ||
                      !candidate.city ||
                      (!candidate.sourceUrl && !candidate.websiteUrl)
                    }
                    onClick={queueCandidate}
                  >
                    Zur Recherche-Queue
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => action("/api/discovery/run")}
                  >
                    Queue jetzt prüfen
                  </button>
                </div>
              </section>

              <section className="panel section-gap">
                <div className="section-heading">
                  <div>
                    <h2>Leads</h2>
                    <p className="muted">{filteredLeads.length} Treffer</p>
                  </div>
                  <div className="filters">
                    <input
                      aria-label="Nach Stadt filtern"
                      placeholder="Stadt"
                      value={filters.city}
                      onChange={(event) =>
                        setFilters({ ...filters, city: event.target.value })
                      }
                    />
                    <select
                      aria-label="Nach Kategorie filtern"
                      value={filters.category}
                      onChange={(event) =>
                        setFilters({ ...filters, category: event.target.value })
                      }
                    >
                      <option value="">Alle Kategorien</option>
                      {LEAD_CATEGORIES.map((category) => (
                        <option key={category}>{category}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Nach Status filtern"
                      value={filters.status}
                      onChange={(event) =>
                        setFilters({ ...filters, status: event.target.value })
                      }
                    >
                      <option value="">Alle Status</option>
                      {LEAD_STATUSES.map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Minimaler Opportunity Score"
                      type="number"
                      min="0"
                      max="100"
                      value={filters.minimumScore}
                      onChange={(event) =>
                        setFilters({
                          ...filters,
                          minimumScore: event.target.value
                        })
                      }
                    />
                  </div>
                </div>
                {filteredLeads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    busy={busy}
                    action={action}
                    qualification={sales?.qualifications.find(
                      (item) => item.leadId === lead.id
                    )}
                    audit={sales?.audits.find(
                      (item) => item.leadId === lead.id
                    )}
                    qualityReview={sales?.qualityReviews.find(
                      (item) => item.leadId === lead.id
                    )}
                  />
                ))}
                {!filteredLeads.length && <Empty>Keine passenden Leads.</Empty>}
              </section>
            </>
          )}

          {view === "audits" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>ReelScan Reports</h2>
                  <p className="muted">
                    Quellengebundene Berichte für interne Auswertung.
                  </p>
                </div>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => downloadReelScan("csv")}
                  >
                    CSV exportieren
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => downloadReelScan("json")}
                  >
                    JSON exportieren
                  </button>
                </div>
              </div>
              {(sales?.audits || []).map((audit) => {
                const lead = sales?.leads.find(
                  (item) => item.id === audit.leadId
                );
                return (
                  <article className="audit-card" key={audit.id}>
                    <div className="finding-head">
                      <div>
                        <strong>{lead?.businessName || "Lead"}</strong>
                        <small>
                          {new Date(audit.createdAt).toLocaleString()}
                        </small>
                      </div>
                      <span>
                        {audit.opportunityScore === null
                          ? "Kein Opportunity Score"
                          : `Opportunity ${audit.opportunityScore}/100`}{" "}
                        · Evidenz {audit.evidenceConfidence}
                      </span>
                    </div>
                    <div className="audit-quality-strip">
                      <span>
                        Beobachtung {audit.qualityMetrics.observationQuality}/5
                      </span>
                      <span>
                        Relevanz {audit.qualityMetrics.businessRelevance}/5
                      </span>
                      <span>
                        Personalisierung {audit.qualityMetrics.personalization}
                        /5
                      </span>
                      <span>
                        Fehlende Evidenz {audit.qualityMetrics.missingEvidence}
                      </span>
                    </div>
                    {(
                      [
                        ["guest_discovery", "A. Guest discovery"],
                        ["guest_decision", "B. Guest decision"],
                        ["guest_action", "C. Guest action"]
                      ] as const
                    ).map(([stage, label]) => (
                      <section className="journey-stage" key={stage}>
                        <h3>{label}</h3>
                        {audit.framework[stage].evaluations.map(
                          (observation) => (
                            <div
                              className={`gastronomy-observation ${observation.kind}`}
                              key={`${observation.signal}-${observation.code}`}
                            >
                              <strong>
                                {observation.signal.replaceAll("_", " ")}
                              </strong>
                              <dl>
                                <div>
                                  <dt>Evidence</dt>
                                  <dd>{observation.evidence}</dd>
                                </div>
                                <div>
                                  <dt>Observation</dt>
                                  <dd>{observation.detail}</dd>
                                </div>
                                <div>
                                  <dt>Impact</dt>
                                  <dd>{observation.impact}</dd>
                                </div>
                                <div>
                                  <dt>Confidence</dt>
                                  <dd>{observation.confidence}</dd>
                                </div>
                              </dl>
                              {observation.kind === "opportunity" && (
                                <p>
                                  <strong>Empfehlung:</strong>{" "}
                                  {observation.suggestion}
                                </p>
                              )}
                              <small>
                                Geprüft am{" "}
                                {new Date(
                                  observation.observedAt
                                ).toLocaleDateString()}{" "}
                                · <a href={observation.sourceUrl}>Quelle</a>
                              </small>
                            </div>
                          )
                        )}
                      </section>
                    ))}
                  </article>
                );
              })}
              {!sales?.audits.length && (
                <Empty>Noch keine ReelScan-Auswertung gespeichert.</Empty>
              )}
            </section>
          )}

          {view === "email-review" && (
            <section className="panel">
              <h2>Email Review</h2>
              <p className="muted">
                Jede aktuelle Entwurfsversion muss den Review bestehen. Eine
                Freigabe gilt exakt für diese Version und eine Nachricht.
              </p>
              {(sales?.drafts || []).map((draft) => (
                <DraftEditor
                  key={draft.id}
                  draft={draft}
                  review={sales?.emailReviews.find(
                    (item) =>
                      item.draftId === draft.id &&
                      item.draftVersion === draft.version
                  )}
                  busy={busy}
                  action={action}
                  mode={sales?.mode || "mock"}
                  outreachEnabled={Boolean(sales?.outreachEnabled)}
                />
              ))}
              {!sales?.drafts.length && (
                <Empty>Noch keine E-Mail-Entwürfe.</Empty>
              )}
            </section>
          )}

          {view === "pipeline" && (
            <>
              <section className="pipeline">
                {LEAD_STATUSES.map((status) => {
                  const leads = (sales?.leads || []).filter(
                    (lead) => lead.status === status
                  );
                  if (!leads.length) return null;
                  return (
                    <div className="panel pipeline-column" key={status}>
                      <h2>
                        {status} <span>{leads.length}</span>
                      </h2>
                      {leads.map((lead) => (
                        <article className="pipeline-card" key={lead.id}>
                          <strong>{lead.businessName}</strong>
                          <span>
                            {lead.city} · Opportunity{" "}
                            {sales?.qualifications.find(
                              (item) => item.leadId === lead.id
                            )?.opportunityScore ?? "keine Evidenz"}
                          </span>
                          <Field
                            label="Status manuell ändern"
                            id={`status-${lead.id}`}
                          >
                            <select
                              id={`status-${lead.id}`}
                              value={lead.status}
                              disabled={busy || lead.doNotContact}
                              onChange={(event) =>
                                action(
                                  `/api/leads/${lead.id}`,
                                  { status: event.target.value as LeadStatus },
                                  "PATCH"
                                )
                              }
                            >
                              {LEAD_STATUSES.map((option) => (
                                <option key={option}>{option}</option>
                              ))}
                            </select>
                          </Field>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={async () => {
                              const output =
                                await action<BusinessAssistantOutput>(
                                  "/api/assistant",
                                  {
                                    leadId: lead.id,
                                    type: "lead_summary"
                                  }
                                );
                              if (output) setAssistantOutput(output);
                            }}
                          >
                            Internes Briefing
                          </button>
                        </article>
                      ))}
                    </div>
                  );
                })}
              </section>
              {assistantOutput && (
                <section className="panel section-gap">
                  <div className="section-heading">
                    <h2>{assistantOutput.title}</h2>
                    <span className="safe-label">
                      Nur intern · keine Aktion
                    </span>
                  </div>
                  {assistantOutput.sections.map((section) => (
                    <div key={section.heading}>
                      <h3>{section.heading}</h3>
                      <p className="preserve-lines">{section.content}</p>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}

          {view === "settings" && (
            <section className="panel narrow">
              <h2>Settings</h2>
              <dl className="facts">
                <div>
                  <dt>E-Mail-Provider</dt>
                  <dd>{sales?.mode || "mock"}</dd>
                </div>
                <div>
                  <dt>Outreach-Killswitch</dt>
                  <dd>{sales?.outreachEnabled ? "Aktiv" : "Deaktiviert"}</dd>
                </div>
                <div>
                  <dt>Tägliches Recherchelimit</dt>
                  <dd>{sales?.limits.newLeadsPerDay || 20}</dd>
                </div>
                <div>
                  <dt>Tägliches Versandlimit</dt>
                  <dd>{sales?.limits.sendsPerDay || 5}</dd>
                </div>
              </dl>
              <div className="notice">
                Einstellungen werden bewusst nicht im Browser geändert. Sichere
                Worker-Konfiguration und Secrets bleiben ausschließlich in
                Cloudflare.
              </div>
            </section>
          )}

          {view === "guardian" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Website Guardian</h2>
                  <p className="muted">Read-only Analyse von /fr/ und /ar/.</p>
                </div>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setReport(
                        await api<AuditReport>("/api/scan", { method: "POST" })
                      );
                    } catch (caught) {
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Prüfung fehlgeschlagen"
                      );
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
                    <article
                      className={`finding ${finding.severity}`}
                      key={`${finding.page}-${index}`}
                    >
                      <strong>{finding.title}</strong>
                      <p>{finding.detail}</p>
                      <small>
                        {finding.page} · {finding.evidence}
                      </small>
                    </article>
                  ))}
                </>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function Field({
  label,
  id,
  children
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function LeadCard({
  lead,
  audit,
  qualification,
  qualityReview,
  busy,
  action
}: {
  lead: Lead;
  audit?: ReelScanLeadAudit;
  qualification?: QualificationResult;
  qualityReview?: LeadQualityReview;
  busy: boolean;
  action: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}) {
  return (
    <article className="lead">
      <div className="finding-head">
        <div>
          <div className="lead-name">
            <strong>{lead.businessName}</strong>
            {lead.pilot && <span className="pilot-label">Pilot</span>}
          </div>
          <small>
            {lead.category} · {lead.city} · {lead.status}
          </small>
        </div>
        <div className="evidence-summary">
          <strong>
            {qualification?.opportunityScore === null ||
            qualification?.opportunityScore === undefined
              ? "Kein Score"
              : `${qualification.opportunityScore}/100`}
          </strong>
          <span>
            Evidenz{" "}
            {qualification?.evidenceConfidence ||
              audit?.evidenceConfidence ||
              "Low"}
          </span>
        </div>
      </div>
      <p>
        {lead.publicEmail || "Keine öffentliche E-Mail"} ·{" "}
        {lead.recommendedService || "ReelScan"}
      </p>
      {qualification && (
        <details>
          <summary>Evidenz und Opportunity-Bewertung</summary>
          <ul>
            {qualification.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="gastronomy-observations">
        {(audit?.observations || [])
          .filter((observation) => observation.kind === "opportunity")
          .map((observation) => (
            <div
              className="gastronomy-observation"
              key={`${observation.signal}-${observation.sourceUrl}`}
            >
              <dl>
                <div>
                  <dt>Evidence</dt>
                  <dd>{observation.evidence}</dd>
                </div>
                <div>
                  <dt>Observation</dt>
                  <dd>{observation.detail}</dd>
                </div>
                <div>
                  <dt>Impact</dt>
                  <dd>{observation.impact}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{observation.confidence}</dd>
                </div>
              </dl>
              <p>
                <strong>Realistische Empfehlung:</strong>{" "}
                {observation.suggestion}
              </p>
            </div>
          ))}
        {!audit?.verifiedOpportunityCount && (
          <Empty>
            Keine ausreichende verifizierte Gastronomie-Evidenz für eine
            Opportunity-Bewertung.
          </Empty>
        )}
      </div>
      <div className="actions">
        {lead.status === "new" &&
          qualification?.recommendedStatus === "qualified" && (
            <button
              disabled={busy}
              onClick={() =>
                action(
                  `/api/leads/${lead.id}`,
                  { status: "qualified" },
                  "PATCH"
                )
              }
            >
              Qualifizierung bestätigen
            </button>
          )}
        <button
          disabled={
            busy ||
            !lead.publicEmail ||
            lead.doNotContact ||
            !["qualified", "draft_ready", "contacted"].includes(lead.status)
          }
          onClick={() =>
            action(`/api/leads/${lead.id}/draft`, {
              language: lead.language,
              kind: "initial"
            })
          }
        >
          Entwurf erstellen
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => action(`/api/leads/${lead.id}/audit`)}
        >
          Neu analysieren
        </button>
        <button
          className="danger"
          disabled={busy || lead.doNotContact}
          onClick={() => action(`/api/leads/${lead.id}/do-not-contact`)}
        >
          Do not contact
        </button>
      </div>
      {lead.pilot && (
        <QualityReviewForm
          lead={lead}
          existing={qualityReview}
          busy={busy}
          action={action}
        />
      )}
    </article>
  );
}

function QualityReviewForm({
  lead,
  existing,
  busy,
  action
}: {
  lead: Lead;
  existing?: LeadQualityReview;
  busy: boolean;
  action: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}) {
  const [review, setReview] = useState({
    realOpportunity: existing?.realOpportunity ?? false,
    observationAccuracy: existing?.observationAccuracy ?? 3,
    emailPersonalization: existing?.emailPersonalization ?? 3,
    scoreUsefulness: existing?.scoreUsefulness ?? 3,
    relevance: existing?.relevance ?? 3,
    notes: existing?.notes ?? ""
  });
  useEffect(() => {
    if (existing)
      setReview({
        realOpportunity: existing.realOpportunity,
        observationAccuracy: existing.observationAccuracy,
        emailPersonalization: existing.emailPersonalization,
        scoreUsefulness: existing.scoreUsefulness,
        relevance: existing.relevance,
        notes: existing.notes
      });
  }, [existing]);
  const rating = (
    key:
      | "observationAccuracy"
      | "emailPersonalization"
      | "scoreUsefulness"
      | "relevance",
    label: string
  ) => (
    <Field label={label} id={`${key}-${lead.id}`}>
      <select
        id={`${key}-${lead.id}`}
        value={review[key]}
        onChange={(event) =>
          setReview({ ...review, [key]: Number(event.target.value) })
        }
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <option value={value} key={value}>
            {value}/5
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <details className="quality-review">
      <summary>
        Leadqualität manuell prüfen
        {existing ? ` · zuletzt ${existing.reviewedAt.slice(0, 10)}` : ""}
      </summary>
      <div className="quality-grid">
        {rating("relevance", "Zielgruppenrelevanz")}
        {rating("observationAccuracy", "Beobachtungsgenauigkeit")}
        {rating("emailPersonalization", "E-Mail-Personalisierung")}
        {rating("scoreUsefulness", "Score-Nutzen")}
      </div>
      <div className="checkbox-field">
        <input
          id={`opportunity-${lead.id}`}
          type="checkbox"
          checked={review.realOpportunity}
          onChange={(event) =>
            setReview({ ...review, realOpportunity: event.target.checked })
          }
        />
        <label htmlFor={`opportunity-${lead.id}`}>Reale Geschäftschance</label>
      </div>
      <Field label="Interne Pilotnotizen" id={`quality-notes-${lead.id}`}>
        <textarea
          id={`quality-notes-${lead.id}`}
          rows={3}
          value={review.notes}
          onChange={(event) =>
            setReview({ ...review, notes: event.target.value })
          }
        />
      </Field>
      <button
        disabled={busy}
        onClick={() => action(`/api/leads/${lead.id}/quality-review`, review)}
      >
        Qualitätsreview speichern
      </button>
    </details>
  );
}

function DraftEditor({
  draft,
  review,
  busy,
  action,
  mode,
  outreachEnabled
}: {
  draft: EmailDraft;
  review?: EmailReview;
  busy: boolean;
  mode: SalesSnapshot["mode"];
  outreachEnabled: boolean;
  action: (path: string, body?: unknown, method?: string) => Promise<unknown>;
}) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.subject, draft.body]);
  const passed = Boolean(
    review?.approved && review.draftVersion === draft.version
  );
  return (
    <article className="draft">
      <div className="finding-head">
        <strong>{draft.kind}</strong>
        <span>
          {draft.status} · v{draft.version}
        </span>
      </div>
      <Field label="Betreff" id={`subject-${draft.id}`}>
        <input
          id={`subject-${draft.id}`}
          value={subject}
          dir={draft.language === "ar" ? "rtl" : "ltr"}
          onChange={(event) => setSubject(event.target.value)}
          disabled={draft.status === "sent"}
        />
      </Field>
      <Field label="Nachricht" id={`body-${draft.id}`}>
        <textarea
          id={`body-${draft.id}`}
          value={body}
          dir={draft.language === "ar" ? "rtl" : "ltr"}
          lang={draft.language}
          onChange={(event) => setBody(event.target.value)}
          disabled={draft.status === "sent"}
          rows={13}
        />
      </Field>
      <div className={`review-result ${passed ? "passed" : "needs-work"}`}>
        <strong>
          Review: {review ? `${review.score}/100` : "noch nicht geprüft"}
        </strong>
        {review?.issues.map((issue) => (
          <span key={issue}>{issue}</span>
        ))}
        {passed && <span>Aktuelle Version ist freigabefähig.</span>}
        {review &&
          !passed &&
          (review.rewrittenSubject !== subject ||
            review.rewrittenBody !== body) && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                action(
                  `/api/drafts/${draft.id}`,
                  {
                    subject: review.rewrittenSubject,
                    body: review.rewrittenBody
                  },
                  "PATCH"
                )
              }
            >
              Sichere Überarbeitung übernehmen
            </button>
          )}
      </div>
      <div className="actions">
        <button
          className="secondary"
          disabled={busy || draft.status === "sent"}
          onClick={() =>
            action(`/api/drafts/${draft.id}`, { subject, body }, "PATCH")
          }
        >
          Edit speichern
        </button>
        <button
          className="secondary"
          disabled={busy || draft.status === "sent"}
          onClick={() => action(`/api/drafts/${draft.id}/review`)}
        >
          Erneut prüfen
        </button>
        <button
          disabled={busy || draft.status !== "draft_ready" || !passed}
          onClick={() => action(`/api/drafts/${draft.id}/approve`)}
        >
          Einmal freigeben
        </button>
        <button
          className="danger"
          disabled={busy || draft.status === "sent"}
          onClick={() => action(`/api/drafts/${draft.id}/reject`)}
        >
          Reject
        </button>
        {draft.status === "approved" &&
          mode !== "draft_only" &&
          outreachEnabled && (
            <button
              disabled={busy}
              onClick={() => action(`/api/drafts/${draft.id}/send`)}
            >
              Einmal senden
            </button>
          )}
      </div>
    </article>
  );
}
