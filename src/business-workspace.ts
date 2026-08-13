import type {
  Activity,
  BusinessContactEvent,
  BusinessFollowUp,
  BusinessSearchResult,
  BusinessWorkspaceProfile,
  BusinessWorkspaceTimelineEvent,
  DiscoveryCandidate,
  EmailDraft,
  EmailReview,
  GastronomyObservation,
  Lead,
  QualificationResult,
  ReelScanLeadAudit
} from "./sales-types";

export const BUSINESS_INTELLIGENCE_WORKSPACE_VERSION = "1.0" as const;

export interface BusinessWorkspaceData {
  lead: Lead | null;
  candidate: DiscoveryCandidate | null;
  audits: ReelScanLeadAudit[];
  qualifications: QualificationResult[];
  drafts: EmailDraft[];
  reviews: EmailReview[];
  activities: Activity[];
  followUps: BusinessFollowUp[];
  contactEvents: BusinessContactEvent[];
}

export function canonicalBusinessSearchResult(
  candidate: DiscoveryCandidate,
  lead?: Lead
): BusinessSearchResult {
  return {
    id: candidate.id,
    leadId: candidate.leadId,
    candidateId: candidate.id,
    businessName: lead?.businessName || candidate.businessName,
    category: lead?.category || candidate.category,
    city: lead?.city || candidate.city,
    country: lead?.country || candidate.country,
    websiteUrl: lead?.websiteUrl || candidate.websiteUrl || null,
    status: lead?.status || candidate.status,
    discoveredAt: candidate.discoveredAt
  };
}

function eventLabel(action: string): string {
  const labels: Record<string, string> = {
    "candidate.discovered": "Business discovered",
    "candidate.duplicate_skipped": "Duplicate merged",
    "candidate.scanned": "ReelScan completed",
    "candidate.approved": "Approved for CRM",
    "candidate.rejected": "Candidate rejected",
    "candidate.ignored": "Candidate ignored",
    "lead.discovered": "Business discovered",
    "audit.completed": "ReelScan completed",
    "qualification.recommended": "Qualification recommendation created",
    "crm.updated": "CRM status updated",
    "email.draft_created": "Email draft created",
    "email.reviewed": "Email review completed",
    "email.review_completed": "Email review completed",
    "email.approved": "Email approved",
    "email.rejected": "Email rejected",
    "contact.reply": "Reply recorded",
    "contact.bounce": "Bounce recorded",
    "contact.opt_out": "Opt-out recorded",
    "pilot.quality_reviewed": "Pilot quality reviewed"
  };
  return labels[action] || action.replaceAll(".", " ");
}

function timelineEvent(
  id: string,
  type: string,
  actor: string,
  createdAt: string,
  details: Record<string, unknown> = {}
): BusinessWorkspaceTimelineEvent {
  return { id, type, label: eventLabel(type), actor, createdAt, details };
}

function opportunityCodes(audit: ReelScanLeadAudit | undefined): Set<string> {
  return new Set(
    (audit?.observations || [])
      .filter(
        (observation) =>
          observation.kind === "opportunity" && observation.verified
      )
      .map((observation) => observation.code)
  );
}

function guardianCategory(
  observation: GastronomyObservation
): "seo" | "ux" | "accessibility" {
  if (["image_alt", "language_missing"].includes(observation.code))
    return "accessibility";
  if (
    ["location_missing", "trust_signals_missing", "food_info_missing"].includes(
      observation.code
    )
  )
    return "seo";
  return "ux";
}

function makeTimeline(
  data: BusinessWorkspaceData
): BusinessWorkspaceTimelineEvent[] {
  const synthetic: BusinessWorkspaceTimelineEvent[] = [];
  if (data.candidate)
    synthetic.push(
      timelineEvent(
        `candidate-created-${data.candidate.id}`,
        "candidate.discovered",
        "system:autonomous-discovery-agent",
        data.candidate.discoveredAt,
        { candidateId: data.candidate.id }
      )
    );
  else if (data.lead)
    synthetic.push(
      timelineEvent(
        `lead-created-${data.lead.id}`,
        "candidate.discovered",
        "system:discovery-agent",
        data.lead.discoveredAt,
        { leadId: data.lead.id }
      )
    );
  for (const audit of data.audits)
    synthetic.push(
      timelineEvent(
        `audit-${audit.id}`,
        "audit.completed",
        "system:reelscan-audit-agent",
        audit.createdAt,
        { auditId: audit.id, confidence: audit.evidenceConfidence }
      )
    );
  for (const qualification of data.qualifications)
    synthetic.push(
      timelineEvent(
        `qualification-${qualification.id}`,
        "qualification.recommended",
        "system:qualification-agent",
        qualification.createdAt,
        {
          qualificationId: qualification.id,
          recommendation: qualification.recommendedStatus
        }
      )
    );
  for (const draft of data.drafts)
    synthetic.push(
      timelineEvent(
        `draft-${draft.id}`,
        "email.draft_created",
        "authenticated-user",
        draft.createdAt,
        { draftId: draft.id, status: draft.status }
      )
    );
  const activityEvents = data.activities.map((activity) =>
    timelineEvent(
      activity.id,
      activity.action,
      activity.actor,
      activity.createdAt,
      activity.details
    )
  );
  const contactEvents = data.contactEvents.map((event) =>
    timelineEvent(
      `contact-${event.id}`,
      `contact.${event.eventType}`,
      event.approvedBy || "system:contact-history",
      event.occurredAt,
      { eventType: event.eventType, subject: event.subject }
    )
  );
  const unique = new Map<string, BusinessWorkspaceTimelineEvent>();
  for (const event of [...synthetic, ...activityEvents, ...contactEvents]) {
    const key = `${event.label}|${event.createdAt}|${String(event.details.auditId || event.details.draftId || "")}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((first, second) =>
    second.createdAt.localeCompare(first.createdAt)
  );
}

export function buildBusinessWorkspace(
  data: BusinessWorkspaceData
): BusinessWorkspaceProfile {
  if (!data.lead && !data.candidate)
    throw new Error("Business profile source is required");
  const lead = data.lead;
  const candidate = data.candidate;
  const audits = [...data.audits].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const qualifications = [...data.qualifications].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const drafts = [...data.drafts].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  const latestAudit = audits[0] || null;
  const previousAudit = audits[1];
  const latestQualification = qualifications[0] || null;
  const latestDraft = drafts[0] || null;
  const latestReview = latestDraft
    ? [...data.reviews]
        .filter((review) => review.draftId === latestDraft.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
    : null;
  const latestCodes = opportunityCodes(latestAudit || undefined);
  const previousCodes = opportunityCodes(previousAudit);
  const timeline = makeTimeline(data);
  const verifiedOpportunities = (latestAudit?.observations || []).filter(
    (observation) => observation.kind === "opportunity" && observation.verified
  );
  const findings: BusinessWorkspaceProfile["websiteGuardian"]["findings"] = {
    seo: [],
    ux: [],
    accessibility: [],
    performance: []
  };
  for (const observation of verifiedOpportunities)
    findings[guardianCategory(observation)].push(observation);
  const missingEvidence = latestQualification?.minimumEvidenceMet
    ? []
    : [
        ...(latestQualification?.reasons || []),
        ...(latestAudit?.observations || [])
          .filter((observation) => observation.kind === "coverage_gap")
          .map((observation) => observation.detail)
      ].filter((value, index, all) => all.indexOf(value) === index);
  const whyInteresting = verifiedOpportunities.length
    ? `${verifiedOpportunities.length} verified guest-facing ${verifiedOpportunities.length === 1 ? "opportunity is" : "opportunities are"} documented for ${lead?.businessName || candidate?.businessName}.`
    : candidate?.priorityReasons[0] ||
      "No verified business opportunity is available yet; a ReelScan is required.";
  const nextStep = !latestAudit
    ? "Run ReelScan and review the resulting evidence."
    : !latestQualification
      ? "Create and review a Qualification recommendation from the verified evidence."
      : candidate && !["approved", "qualified"].includes(candidate.status)
        ? "Review the completed evidence and decide whether to approve, reject or ignore this candidate."
        : latestDraft && latestReview && !latestReview.approved
          ? "Rewrite the draft using the Email Review reasons before any approval."
          : "Review the latest evidence and choose the next CRM action manually.";
  const currentStatus = lead?.status || candidate?.status || "unknown";
  const headerId = candidate?.id || lead?.id || "";
  return {
    id: headerId,
    header: {
      leadId: lead?.id || null,
      candidateId: candidate?.id || null,
      businessName: lead?.businessName || candidate?.businessName || "",
      category: lead?.category || candidate!.category,
      city: lead?.city || candidate?.city || "",
      country: lead?.country || candidate?.country || "MA",
      websiteUrl: lead?.websiteUrl || candidate?.websiteUrl || null,
      phone: lead?.phone || candidate?.phone || null,
      publicEmail: lead?.publicEmail || candidate?.publicEmail || null,
      socialLinks: candidate?.socialLinks || [],
      discoveredAt: candidate?.discoveredAt || lead?.discoveredAt || "",
      currentStatus
    },
    overview: {
      opportunityScore: latestQualification?.opportunityScore ?? null,
      confidence:
        latestQualification?.evidenceConfidence ||
        latestAudit?.evidenceConfidence ||
        candidate?.confidence ||
        "Low",
      currentRecommendation:
        latestQualification?.recommendedStatus ||
        lead?.recommendedService ||
        "ReelScan required",
      lastActivity: timeline[0] || null,
      assignedStatus: currentStatus,
      timelineSummary: `${timeline.length} recorded event${timeline.length === 1 ? "" : "s"}; latest ${timeline[0]?.label || "not available"}.`
    },
    discovery: {
      sourceUrls: candidate?.sourceUrls || lead?.sourceUrls || [],
      priorityScore: candidate?.priorityScore ?? null,
      priorityReasons: candidate?.priorityReasons || [],
      duplicateStatus: data.activities.some(
        (activity) => activity.action === "candidate.duplicate_skipped"
      )
        ? "merged_duplicate"
        : candidate
          ? "canonical"
          : "not_recorded",
      learningAdjustment: candidate?.learningAdjustment || 0,
      history: timeline.filter((event) => event.type.startsWith("candidate."))
    },
    reelScan: {
      latest: latestAudit,
      history: audits,
      comparison: {
        previousScanAt: previousAudit?.createdAt || null,
        newOpportunityCodes: [...latestCodes].filter(
          (code) => !previousCodes.has(code)
        ),
        resolvedOpportunityCodes: [...previousCodes].filter(
          (code) => !latestCodes.has(code)
        )
      }
    },
    websiteGuardian: {
      source: "reelscan_evidence",
      currentHealth: !latestAudit
        ? "not_scanned"
        : verifiedOpportunities.length
          ? "needs_attention"
          : "evidence_available",
      latestReportAt: latestAudit?.createdAt || null,
      findings,
      trend: [...audits].reverse().map((audit) => ({
        createdAt: audit.createdAt,
        verifiedOpportunities: audit.verifiedOpportunityCount,
        confidence: audit.evidenceConfidence
      })),
      limitations: [
        "Website health is derived from existing public ReelScan evidence.",
        "Performance timing is not collected by the current ReelScan and is shown as not measured."
      ]
    },
    qualification: {
      latest: latestQualification,
      history: qualifications,
      missingEvidence,
      evidenceEditable: false
    },
    crm: {
      currentStage: lead?.status || "Not in CRM",
      notes: lead?.notes || "",
      assignedOwner: null,
      followUps: [...data.followUps].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      ),
      contactHistory: [...data.contactEvents].sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt)
      ),
      statusTimeline: timeline.filter(
        (event) =>
          event.type.startsWith("crm.") ||
          event.type.startsWith("candidate.approved") ||
          event.type.startsWith("contact.")
      )
    },
    emailReview: { latestDraft, latestReview },
    timeline,
    insights: {
      whyInteresting,
      biggestOpportunities: verifiedOpportunities
        .slice(0, 3)
        .map((observation) => observation.detail),
      nextStep,
      factsOnly: true
    }
  };
}

export function businessMatchesSearch(
  result: BusinessSearchResult,
  query: string
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    result.businessName,
    result.city,
    result.category,
    result.country,
    result.websiteUrl || "",
    result.status
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}
