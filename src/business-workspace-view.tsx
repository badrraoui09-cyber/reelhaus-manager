import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BusinessSearchResult,
  BusinessWorkspaceProfile,
  GastronomyObservation
} from "./sales-types";
import { Icon, type IconName } from "./ui-icons";

interface SearchResponse {
  version: string;
  results: BusinessSearchResult[];
}

interface ProfileResponse {
  version: string;
  profile: BusinessWorkspaceProfile;
}

interface BusinessWorkspaceViewProps {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  action: (path: string, body?: unknown, method?: string) => Promise<unknown>;
  busy: boolean;
  initialQuery?: string;
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Nicht verfügbar";
}

function displayPublicValue(value: string | null): string {
  if (!value) return "Nicht verfügbar";
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value;
  }
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function statusClass(value: string): string {
  return value.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
}

function Highlight({ text, query }: { text: string; query: string }) {
  const term = query.trim();
  if (!term) return text;
  const index = text.toLowerCase().indexOf(term.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </>
  );
}

function WorkspaceEmpty({
  icon = "sparkles",
  title,
  children
}: {
  icon?: IconName;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="workspace-empty">
      <span>
        <Icon name={icon} />
      </span>
      {title && <strong>{title}</strong>}
      <p>{children}</p>
    </div>
  );
}

function ObservationList({
  observations
}: {
  observations: GastronomyObservation[];
}) {
  if (!observations.length)
    return (
      <WorkspaceEmpty icon="scan">
        Keine verifizierten Findings in diesem Bereich.
      </WorkspaceEmpty>
    );
  return (
    <div className="workspace-observations">
      {observations.map((observation) => (
        <article
          className={`workspace-observation ${observation.kind}`}
          key={`${observation.code}-${observation.sourceUrl}`}
        >
          <div className="workspace-observation-heading">
            <span className={`observation-kind ${observation.kind}`}>
              {observation.kind}
            </span>
            <strong>{observation.detail}</strong>
            <span className="confidence-pill">{observation.confidence}</span>
          </div>
          <dl className="workspace-observation-grid">
            <div>
              <dt>Evidence</dt>
              <dd>{observation.evidence}</dd>
            </div>
            <div>
              <dt>Guest impact</dt>
              <dd>{observation.impact}</dd>
            </div>
            <div>
              <dt>Recommendation</dt>
              <dd>{observation.suggestion}</dd>
            </div>
          </dl>
          <a href={observation.sourceUrl} target="_blank" rel="noreferrer">
            <Icon name="external" /> Quelle öffnen
          </a>
        </article>
      ))}
    </div>
  );
}

function SectionTitle({
  eyebrow,
  title,
  action
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function BusinessWorkspaceView({
  request,
  action,
  busy,
  initialQuery = ""
}: BusinessWorkspaceViewProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<BusinessSearchResult[]>([]);
  const [profile, setProfile] = useState<BusinessWorkspaceProfile | null>(null);
  const [version, setVersion] = useState("1.0");
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [localError, setLocalError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await request<SearchResponse>(
          `/api/businesses/search?q=${encodeURIComponent(query)}`
        );
        if (!cancelled) {
          setResults(response.results);
          setVersion(response.version);
          setLocalError("");
        }
      } catch (error) {
        if (!cancelled)
          setLocalError(
            error instanceof Error ? error.message : "Suche fehlgeschlagen"
          );
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, request]);

  async function loadProfile(id: string) {
    setLoading(true);
    setLocalError("");
    try {
      const response = await request<ProfileResponse>(
        `/api/businesses/${encodeURIComponent(id)}/workspace`
      );
      setProfile(response.profile);
      setVersion(response.version);
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "Business-Profil fehlgeschlagen"
      );
    } finally {
      setLoading(false);
    }
  }

  async function runNewScan() {
    if (!profile) return;
    if (profile.header.leadId)
      await action(`/api/leads/${profile.header.leadId}/audit`);
    else if (profile.header.candidateId)
      await action(
        `/api/discovery/candidates/${profile.header.candidateId}/scan`,
        {}
      );
    await loadProfile(profile.id);
  }

  const latestAudit = profile?.reelScan.latest;
  const latestQualification = profile?.qualification.latest;
  const latestDraft = profile?.emailReview.latestDraft;
  const latestReview = profile?.emailReview.latestReview;
  const scanAvailable = Boolean(
    profile?.header.leadId ||
    (profile?.header.candidateId &&
      ["new", "queued"].includes(profile.header.currentStatus))
  );

  return (
    <div className="business-workspace">
      <aside className="workspace-directory">
        <div className="workspace-directory-head">
          <div>
            <span className="eyebrow">Directory</span>
            <strong>Businesses</strong>
          </div>
          <span className="result-count">{results.length}</span>
        </div>
        <div className="workspace-search-box">
          <Icon name="search" />
          <input
            aria-label="Global business search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0])
                void loadProfile(results[0].id);
            }}
            placeholder="Name, Stadt, Website…"
            ref={searchRef}
            type="search"
            value={query}
          />
          {searching && <span className="search-spinner" />}
        </div>
        {localError && <div className="error compact">{localError}</div>}
        <div className="workspace-result-list">
          {results.map((result) => (
            <button
              aria-current={profile?.id === result.id ? "true" : undefined}
              className={profile?.id === result.id ? "active" : ""}
              key={result.id}
              onClick={() => loadProfile(result.id)}
            >
              <span className="business-avatar">
                {result.businessName.slice(0, 2).toUpperCase()}
              </span>
              <span className="result-copy">
                <strong>
                  <Highlight text={result.businessName} query={query} />
                </strong>
                <small>
                  <Highlight
                    text={`${result.city} · ${result.category}`}
                    query={query}
                  />
                </small>
              </span>
              <span className={`mini-status ${statusClass(result.status)}`}>
                {result.status.replaceAll("_", " ")}
              </span>
            </button>
          ))}
          {!results.length && !searching && !localError && (
            <WorkspaceEmpty icon="search" title="Keine Treffer">
              Suche nach Name, Stadt, Kategorie, Land, Website oder Status.
            </WorkspaceEmpty>
          )}
        </div>
        <div className="workspace-directory-footer">
          <span>Workspace v{version}</span>
          <span>⌘K Schnellsuche</span>
        </div>
      </aside>

      <section className="workspace-profile-column">
        {loading && (
          <div
            className="workspace-loading"
            aria-label="Business profile loading"
          >
            <div className="skeleton hero" />
            <div className="skeleton row" />
            <div className="skeleton card" />
            <div className="skeleton card" />
          </div>
        )}

        {!profile && !loading && (
          <div className="workspace-welcome">
            <span className="welcome-mark">
              <Icon name="business" />
            </span>
            <p className="eyebrow">Business Intelligence Workspace</p>
            <h1>Ein Betrieb. Der ganze Kontext.</h1>
            <p>
              Öffne links einen Betrieb, um Discovery, ReelScan, Guardian,
              Qualification, CRM und Email Review in einer Ansicht zu verbinden.
            </p>
            <div className="welcome-features">
              <span>
                <Icon name="check" /> Nur verifizierte Evidenz
              </span>
              <span>
                <Icon name="check" /> Vollständige Timeline
              </span>
              <span>
                <Icon name="check" /> Menschliche Kontrolle
              </span>
            </div>
            {results[0] && (
              <button onClick={() => loadProfile(results[0].id)}>
                Ersten Betrieb öffnen <Icon name="arrow" />
              </button>
            )}
          </div>
        )}

        {profile && !loading && (
          <>
            <section className="workspace-profile-header">
              <div className="workspace-profile-identity">
                <span className="business-avatar large">
                  {profile.header.businessName.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <div className="workspace-title-row">
                    <h1>{profile.header.businessName}</h1>
                    <span
                      className={`status-pill ${statusClass(profile.header.currentStatus)}`}
                    >
                      {profile.header.currentStatus.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p>
                    {profile.header.category} · {profile.header.city},{" "}
                    {profile.header.country}
                  </p>
                </div>
              </div>
              <div className="workspace-profile-links">
                {profile.header.websiteUrl && (
                  <a
                    className="button secondary"
                    href={profile.header.websiteUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Website <Icon name="external" />
                  </a>
                )}
                <button disabled={busy || !scanAvailable} onClick={runNewScan}>
                  <Icon name="scan" /> Neuer Scan
                </button>
              </div>
              <dl className="workspace-contact-strip">
                <div>
                  <dt>Telefon</dt>
                  <dd>{displayPublicValue(profile.header.phone)}</dd>
                </div>
                <div>
                  <dt>Public email</dt>
                  <dd>{profile.header.publicEmail || "Nicht verfügbar"}</dd>
                </div>
                <div>
                  <dt>Entdeckt</dt>
                  <dd>{formatDate(profile.header.discoveredAt)}</dd>
                </div>
                <div>
                  <dt>Social</dt>
                  <dd>
                    {profile.header.socialLinks.length
                      ? profile.header.socialLinks.map((link) => (
                          <a
                            key={link}
                            href={link}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {hostname(link)}
                          </a>
                        ))
                      : "Nicht verfügbar"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="workspace-kpi-grid">
              {[
                [
                  profile.overview.opportunityScore === null
                    ? "—"
                    : `${profile.overview.opportunityScore}`,
                  "Opportunity",
                  "/100"
                ],
                [profile.overview.confidence, "Confidence", "evidence"],
                [
                  profile.discovery.priorityScore === null
                    ? "—"
                    : `${profile.discovery.priorityScore}`,
                  "Discovery priority",
                  "/100"
                ],
                [profile.overview.assignedStatus, "Assigned status", "current"]
              ].map(([value, label, helper]) => (
                <article key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{helper}</small>
                </article>
              ))}
            </section>

            <section className="panel workspace-insights">
              <SectionTitle
                eyebrow="Evidence-grounded insights"
                title="Was jetzt zählt"
                action={
                  <span className="safe-label">Keine erfundenen Daten</span>
                }
              />
              <div className="workspace-insight-grid">
                <div>
                  <span className="insight-number">01</span>
                  <h3>Warum interessant?</h3>
                  <p>{profile.insights.whyInteresting}</p>
                </div>
                <div>
                  <span className="insight-number">02</span>
                  <h3>Größte Chancen</h3>
                  {profile.insights.biggestOpportunities.length ? (
                    <ul>
                      {profile.insights.biggestOpportunities.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>Keine verifizierten Chancen.</p>
                  )}
                </div>
                <div>
                  <span className="insight-number">03</span>
                  <h3>Nächster Schritt</h3>
                  <p>{profile.insights.nextStep}</p>
                </div>
              </div>
            </section>

            <section className="panel workspace-module">
              <SectionTitle
                eyebrow="ReelScan"
                title="Gastronomie-Intelligence"
                action={
                  <span className="module-meta">
                    {latestAudit
                      ? formatDate(latestAudit.createdAt)
                      : "Noch kein Scan"}
                  </span>
                }
              />
              {latestAudit ? (
                <>
                  <div className="module-stat-strip">
                    <span>
                      <strong>
                        {Object.values(latestAudit.framework).reduce(
                          (total, stage) => total + stage.evaluations.length,
                          0
                        )}
                      </strong>{" "}
                      Evaluations
                    </span>
                    <span>
                      <strong>{latestAudit.verifiedOpportunityCount}</strong>{" "}
                      verified opportunities
                    </span>
                    <span>
                      <strong>{latestAudit.evidenceConfidence}</strong>{" "}
                      confidence
                    </span>
                  </div>
                  <ObservationList observations={latestAudit.observations} />
                  <div className="details-grid">
                    <details>
                      <summary>
                        Scan history ({profile.reelScan.history.length})
                      </summary>
                      {profile.reelScan.history.map((audit) => (
                        <div className="workspace-history-row" key={audit.id}>
                          <span>{formatDate(audit.createdAt)}</span>
                          <strong>
                            {audit.verifiedOpportunityCount} opportunities ·{" "}
                            {audit.evidenceConfidence}
                          </strong>
                        </div>
                      ))}
                    </details>
                    <details>
                      <summary>Scans vergleichen</summary>
                      {profile.reelScan.comparison.previousScanAt ? (
                        <div className="workspace-comparison">
                          <p>
                            Vorher:{" "}
                            {formatDate(
                              profile.reelScan.comparison.previousScanAt
                            )}
                          </p>
                          <p>
                            <strong>Neu:</strong>{" "}
                            {profile.reelScan.comparison.newOpportunityCodes.join(
                              ", "
                            ) || "Keine"}
                          </p>
                          <p>
                            <strong>Gelöst:</strong>{" "}
                            {profile.reelScan.comparison.resolvedOpportunityCodes.join(
                              ", "
                            ) || "Keine"}
                          </p>
                        </div>
                      ) : (
                        <WorkspaceEmpty icon="activity">
                          Kein vorheriger Scan verfügbar.
                        </WorkspaceEmpty>
                      )}
                    </details>
                  </div>
                </>
              ) : (
                <WorkspaceEmpty icon="scan" title="Noch kein ReelScan">
                  Starte einen kontrollierten Scan, um öffentliche Evidenz zu
                  erfassen.
                </WorkspaceEmpty>
              )}
            </section>

            <div className="workspace-module-grid">
              <section className="panel workspace-module">
                <SectionTitle
                  eyebrow="Discovery"
                  title="Candidate intelligence"
                />
                <dl className="facts compact-facts">
                  <div>
                    <dt>Priority</dt>
                    <dd>
                      {profile.discovery.priorityScore === null
                        ? "Nicht erfasst"
                        : `${profile.discovery.priorityScore}/100`}
                    </dd>
                  </div>
                  <div>
                    <dt>Duplicate</dt>
                    <dd>{profile.discovery.duplicateStatus}</dd>
                  </div>
                  <div>
                    <dt>Learning</dt>
                    <dd>{profile.discovery.learningAdjustment}</dd>
                  </div>
                </dl>
                <h3>Begründung</h3>
                {profile.discovery.priorityReasons.length ? (
                  <ul>
                    {profile.discovery.priorityReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <WorkspaceEmpty icon="search">
                    Keine Discovery-Priorität erfasst.
                  </WorkspaceEmpty>
                )}
                <details>
                  <summary>Quellen & Discovery History</summary>
                  {profile.discovery.sourceUrls.map((source) => (
                    <a
                      className="workspace-source"
                      href={source}
                      key={source}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source}
                    </a>
                  ))}
                  {profile.discovery.history.map((event) => (
                    <div className="workspace-history-row" key={event.id}>
                      <strong>{event.label}</strong>
                      <time>{formatDate(event.createdAt)}</time>
                    </div>
                  ))}
                </details>
              </section>

              <section className="panel workspace-module">
                <SectionTitle
                  eyebrow="Qualification"
                  title="Evidence gate"
                  action={<span className="safe-label">Read-only</span>}
                />
                {latestQualification ? (
                  <>
                    <dl className="facts compact-facts">
                      <div>
                        <dt>Recommendation</dt>
                        <dd>{latestQualification.recommendedStatus}</dd>
                      </div>
                      <div>
                        <dt>Threshold</dt>
                        <dd>
                          {latestQualification.minimumEvidenceMet
                            ? "Erfüllt"
                            : "Nicht erfüllt"}
                        </dd>
                      </div>
                      <div>
                        <dt>Observations</dt>
                        <dd>
                          {latestQualification.criteria.verifiedObservations ??
                            "Nicht erfasst"}
                        </dd>
                      </div>
                      <div>
                        <dt>Journey stages</dt>
                        <dd>
                          {latestQualification.criteria.journeyStagesCovered ??
                            "Nicht erfasst"}
                        </dd>
                      </div>
                    </dl>
                    <h3>Fehlende Evidenz</h3>
                    {profile.qualification.missingEvidence.length ? (
                      <ul>
                        {profile.qualification.missingEvidence.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="positive-copy">
                        <Icon name="check" /> Keine fehlende Evidenz gemeldet.
                      </p>
                    )}
                    <details>
                      <summary>
                        Qualification history (
                        {profile.qualification.history.length})
                      </summary>
                      {profile.qualification.history.map((item) => (
                        <div className="workspace-history-row" key={item.id}>
                          <time>{formatDate(item.createdAt)}</time>
                          <strong>{item.recommendedStatus}</strong>
                        </div>
                      ))}
                    </details>
                  </>
                ) : (
                  <WorkspaceEmpty icon="scan">
                    Noch keine Qualification-Empfehlung.
                  </WorkspaceEmpty>
                )}
              </section>
            </div>

            <section className="panel workspace-module">
              <SectionTitle
                eyebrow="Website Guardian"
                title="Website health"
                action={
                  <span
                    className={`status-pill ${statusClass(profile.websiteGuardian.currentHealth)}`}
                  >
                    {profile.websiteGuardian.currentHealth}
                  </span>
                }
              />
              <p className="muted">
                Letzter Report:{" "}
                {formatDate(profile.websiteGuardian.latestReportAt)} · aus
                öffentlicher ReelScan-Evidenz
              </p>
              <div className="workspace-guardian-grid">
                {(["seo", "ux", "accessibility", "performance"] as const).map(
                  (category) => (
                    <details
                      key={category}
                      open={category === "seo" || category === "ux"}
                    >
                      <summary>
                        {category}
                        <span>
                          {profile.websiteGuardian.findings[category].length}
                        </span>
                      </summary>
                      {category === "performance" ? (
                        <WorkspaceEmpty icon="activity">
                          Im aktuellen ReelScan nicht gemessen.
                        </WorkspaceEmpty>
                      ) : (
                        <ObservationList
                          observations={
                            profile.websiteGuardian.findings[category]
                          }
                        />
                      )}
                    </details>
                  )
                )}
              </div>
            </section>

            <div className="workspace-module-grid">
              <section className="panel workspace-module">
                <SectionTitle eyebrow="CRM" title="Relationship workspace" />
                <dl className="facts compact-facts">
                  <div>
                    <dt>Stage</dt>
                    <dd>{profile.crm.currentStage}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{profile.crm.assignedOwner || "Nicht zugewiesen"}</dd>
                  </div>
                  <div>
                    <dt>Notes</dt>
                    <dd>{profile.crm.notes || "Keine Notizen"}</dd>
                  </div>
                </dl>
                <details>
                  <summary>Follow-ups ({profile.crm.followUps.length})</summary>
                  {profile.crm.followUps.length ? (
                    profile.crm.followUps.map((followUp) => (
                      <div className="workspace-history-row" key={followUp.id}>
                        <span>
                          Sequence {followUp.sequence} · {followUp.status}
                        </span>
                        <time>{formatDate(followUp.scheduledFor)}</time>
                      </div>
                    ))
                  ) : (
                    <WorkspaceEmpty icon="clock">
                      Keine Follow-ups erfasst.
                    </WorkspaceEmpty>
                  )}
                </details>
                <details>
                  <summary>
                    Contact history ({profile.crm.contactHistory.length})
                  </summary>
                  {profile.crm.contactHistory.length ? (
                    profile.crm.contactHistory.map((event) => (
                      <div className="workspace-history-row" key={event.id}>
                        <strong>{event.eventType}</strong>
                        <time>{formatDate(event.occurredAt)}</time>
                      </div>
                    ))
                  ) : (
                    <WorkspaceEmpty icon="activity">
                      Keine Kontaktereignisse erfasst.
                    </WorkspaceEmpty>
                  )}
                </details>
              </section>
              <section className="panel workspace-module">
                <SectionTitle
                  eyebrow="Email Review"
                  title="Latest controlled draft"
                />
                {latestDraft ? (
                  <>
                    <span
                      className={`status-pill ${statusClass(latestDraft.status)}`}
                    >
                      {latestDraft.status}
                    </span>
                    <h3>{latestDraft.subject}</h3>
                    <p className="preserve-lines email-preview">
                      {latestDraft.body}
                    </p>
                    {latestReview ? (
                      <div
                        className={`review-banner ${latestReview.approved ? "approved" : "rejected"}`}
                      >
                        <strong>
                          {latestReview.approved ? "Accepted" : "Rejected"}
                        </strong>
                        <span>
                          Personalization {latestReview.personalization}/5 ·
                          Score {latestReview.score}/100
                        </span>
                        {latestReview.issues.length > 0 && (
                          <ul>
                            {latestReview.issues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : (
                      <WorkspaceEmpty icon="mail">
                        Kein Review für diesen Entwurf.
                      </WorkspaceEmpty>
                    )}
                  </>
                ) : (
                  <WorkspaceEmpty icon="mail">
                    Noch kein E-Mail-Entwurf.
                  </WorkspaceEmpty>
                )}
              </section>
            </div>
          </>
        )}
      </section>

      <aside className="workspace-action-rail">
        {profile ? (
          <>
            <section className="rail-card recommendation-card">
              <span className="rail-icon">
                <Icon name="sparkles" />
              </span>
              <p className="eyebrow">Recommended next</p>
              <h2>{profile.overview.currentRecommendation}</h2>
              <p>{profile.insights.nextStep}</p>
              <button disabled={busy || !scanAvailable} onClick={runNewScan}>
                Scan ausführen <Icon name="arrow" />
              </button>
            </section>
            <section className="rail-card">
              <div className="rail-heading">
                <h2>Timeline</h2>
                <span>{profile.timeline.length}</span>
              </div>
              <p className="muted">{profile.overview.timelineSummary}</p>
              <ol className="workspace-timeline compact">
                {profile.timeline.slice(0, 8).map((event) => (
                  <li key={event.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{event.label}</strong>
                      <span>{event.actor}</span>
                      <time>{formatDate(event.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
              {profile.timeline.length > 8 && (
                <details>
                  <summary>Alle {profile.timeline.length} Events</summary>
                  {profile.timeline.slice(8).map((event) => (
                    <div className="workspace-history-row" key={event.id}>
                      <strong>{event.label}</strong>
                      <time>{formatDate(event.createdAt)}</time>
                    </div>
                  ))}
                </details>
              )}
            </section>
            <section className="rail-card safeguards-card">
              <div>
                <Icon name="shield" />
                <strong>Safeguards active</strong>
              </div>
              <span>
                <Icon name="check" /> Evidence is read-only
              </span>
              <span>
                <Icon name="check" /> Manual approval required
              </span>
              <span>
                <Icon name="check" /> Outreach disabled
              </span>
            </section>
          </>
        ) : (
          <section className="rail-card rail-placeholder">
            <Icon name="activity" />
            <h2>Context, not clutter</h2>
            <p>
              Timeline, Empfehlungen und sichere Aktionen erscheinen hier nach
              der Auswahl.
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}
