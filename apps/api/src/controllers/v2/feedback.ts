import { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { autumnService } from "../../services/autumn/autumn.service";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import {
  isPostgrestNoRowsError,
  supabase_rr_service,
  supabase_service,
} from "../../services/supabase";
import {
  EndpointFeedbackEndpoint,
  EndpointFeedbackErrorCode,
  EndpointFeedbackRequest,
  EndpointFeedbackResponse,
  RequestWithAuth,
  SearchFeedbackErrorCode,
  SearchFeedbackRequest,
  endpointFeedbackSchema,
} from "./types";

const PREVIEW_TEAM_ID = "3adefd26-77ec-5968-8dcf-c94b5630d1de";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const FEEDBACK_LOOKUP_RACE_RETRY_MS = 250;

type FeedbackRating = "good" | "partial" | "bad";

type FeedbackInput = {
  rating: FeedbackRating;
  issues?: string[];
  tags?: string[];
  note?: string;
  valuableSources?: Array<{ url: string; reason?: string }>;
  missingContent?: Array<{ topic: string; description?: string }>;
  querySuggestions?: string;
  expected?: unknown;
  actual?: unknown;
  url?: string;
  pageNumbers?: number[];
  metadata?: Record<string, unknown>;
  origin?: string;
  integration?: string | null;
};

type FeedbackJobRow = {
  endpoint: EndpointFeedbackEndpoint;
  id: string;
  request_id: string | null;
  team_id: string;
  credits_cost: number | null;
  created_at: string;
  is_successful: boolean | null;
  options: unknown;
};

type FeedbackRecordOptions = {
  endpoint: EndpointFeedbackEndpoint;
  jobId: string;
  feedback: FeedbackInput;
  requireSuccessfulJob?: boolean;
  notFoundCode?: EndpointFeedbackErrorCode | SearchFeedbackErrorCode;
  failedJobCode?: SearchFeedbackErrorCode;
  dbDisabledMessage?: string;
  windowExpiredMessage?: string;
  maxAgeSec?: number;
  dailyCapCredits?: number;
  source: "endpoint_feedback" | "search_feedback";
};

type FeedbackRecordResult = {
  status: number;
  body: EndpointFeedbackResponse | any;
};

type RefundPolicySnapshot = {
  version: "feedback_refund_v1";
  enabled: boolean;
  endpoint: EndpointFeedbackEndpoint;
  mode: "none" | "flat" | "percentage_with_cap";
  refundableRatings: FeedbackRating[];
  matchedReason: string;
  flatCredits?: number;
  percent?: number;
  maxCredits?: number;
};

function isPreviewTeam(teamId: string): boolean {
  return teamId === "preview" || teamId.startsWith("preview_");
}

function normalizeTeamId(teamId: string): string {
  return isPreviewTeam(teamId) ? PREVIEW_TEAM_ID : teamId;
}

function startOfUtcDay(now: Date = new Date()): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function fail(
  status: number,
  code: EndpointFeedbackErrorCode | SearchFeedbackErrorCode,
  error: string,
): FeedbackRecordResult {
  return {
    status,
    body: {
      success: false,
      error,
      feedbackErrorCode: code,
    },
  };
}

function toFeedbackInput(
  body: EndpointFeedbackRequest | SearchFeedbackRequest,
): FeedbackInput {
  return {
    rating: body.rating,
    valuableSources: body.valuableSources,
    missingContent: body.missingContent,
    querySuggestions: body.querySuggestions,
    origin: body.origin,
    integration: body.integration,
    ...("issues" in body ? { issues: body.issues } : {}),
    ...("tags" in body ? { tags: body.tags } : {}),
    ...("note" in body ? { note: body.note } : {}),
    ...("expected" in body ? { expected: body.expected } : {}),
    ...("actual" in body ? { actual: body.actual } : {}),
    ...("url" in body ? { url: body.url } : {}),
    ...("pageNumbers" in body ? { pageNumbers: body.pageNumbers } : {}),
    ...("metadata" in body ? { metadata: body.metadata } : {}),
  };
}

function tableForEndpoint(endpoint: EndpointFeedbackEndpoint): string {
  switch (endpoint) {
    case "search":
      return "searches";
    case "scrape":
      return "scrapes";
    case "parse":
      return "parses";
    case "map":
      return "maps";
  }
}

function selectForEndpoint(endpoint: EndpointFeedbackEndpoint): string {
  switch (endpoint) {
    case "map":
      return "id, request_id, team_id, credits_cost, created_at, options";
    default:
      return "id, request_id, team_id, credits_cost, created_at, is_successful, options";
  }
}

async function lookupJobRow(
  endpoint: EndpointFeedbackEndpoint,
  jobId: string,
  dbTeamId: string,
): Promise<FeedbackJobRow | null> {
  const { data, error } = await supabase_rr_service
    .from(tableForEndpoint(endpoint))
    .select(selectForEndpoint(endpoint))
    .eq("id", jobId)
    .eq("team_id", dbTeamId)
    .single();

  if (error) {
    if (isPostgrestNoRowsError(error)) return null;
    throw error;
  }

  if (!data) return null;

  const row = data as any;
  return {
    endpoint,
    id: row.id,
    request_id: row.request_id ?? null,
    team_id: row.team_id,
    credits_cost: row.credits_cost ?? 0,
    created_at: row.created_at,
    is_successful: endpoint === "map" ? true : (row.is_successful ?? null),
    options: row.options ?? null,
  };
}

async function sumEndpointCreditsRefundedToday(
  dbTeamId: string,
  endpoint: EndpointFeedbackEndpoint,
  logger: ReturnType<typeof _logger.child>,
): Promise<number> {
  const since = startOfUtcDay().toISOString();
  const { data, error } = await supabase_rr_service
    .from("endpoint_feedback")
    .select("credits_refunded")
    .eq("team_id", dbTeamId)
    .gte("created_at", since);

  if (error) {
    logger.warn(
      "Failed to compute endpoint feedback refund total; allowing refund this call",
      { error },
    );
    return 0;
  }

  const endpointTotal = (data ?? []).reduce(
    (sum, row: { credits_refunded: number | null }) =>
      sum + (row.credits_refunded ?? 0),
    0,
  );

  if (endpoint !== "search") {
    return endpointTotal;
  }

  const { data: legacyData, error: legacyError } = await supabase_rr_service
    .from("search_feedback")
    .select("credits_refunded")
    .eq("team_id", dbTeamId)
    .gte("created_at", since);

  if (legacyError) {
    logger.warn("Failed to compute legacy search feedback refund total", {
      error: legacyError,
    });
    return endpointTotal;
  }

  const legacyTotal = (legacyData ?? []).reduce(
    (sum, row: { credits_refunded: number | null }) =>
      sum + (row.credits_refunded ?? 0),
    0,
  );

  // Search feedback is mirrored into the old table during migration. Taking
  // the max preserves old rows without double-counting mirrored new rows.
  return Math.max(endpointTotal, legacyTotal);
}

async function findExistingLegacySearchFeedback(
  searchId: string,
  dbTeamId: string,
): Promise<{ id: string; credits_refunded: number | null } | null> {
  const { data, error } = await supabase_rr_service
    .from("search_feedback")
    .select("id, credits_refunded")
    .eq("search_id", searchId)
    .eq("team_id", dbTeamId)
    .single();

  if (error) {
    if (isPostgrestNoRowsError(error)) return null;
    throw error;
  }

  return data as { id: string; credits_refunded: number | null } | null;
}

async function mirrorSearchFeedback(
  feedbackId: string,
  jobId: string,
  dbTeamId: string,
  feedback: FeedbackInput,
  creditsRefunded: number,
  logger: ReturnType<typeof _logger.child>,
) {
  const row = {
    id: feedbackId,
    search_id: jobId,
    team_id: dbTeamId,
    overall_rating: feedback.rating,
    valuable_sources: feedback.valuableSources ?? [],
    missing_content: feedback.missingContent ?? [],
    query_suggestions: feedback.querySuggestions ?? null,
    integration: feedback.integration ?? null,
    origin: feedback.origin ?? null,
    credits_refunded: creditsRefunded,
  };

  const { error } = await supabase_service.from("search_feedback").insert(row);
  if (!error) return;

  if ((error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
    const { error: updateErr } = await supabase_service
      .from("search_feedback")
      .update({ credits_refunded: creditsRefunded })
      .eq("search_id", jobId)
      .eq("team_id", dbTeamId);

    if (updateErr) {
      logger.warn("Failed to update mirrored search_feedback row", {
        error: updateErr,
        feedbackId,
        jobId,
      });
    }
    return;
  }

  logger.warn("Failed to mirror endpoint feedback into search_feedback", {
    error,
    feedbackId,
    jobId,
  });
}

function hasJsonFormat(options: unknown): boolean {
  const formats = (options as { formats?: unknown })?.formats;
  if (!Array.isArray(formats)) return false;
  return formats.some(format => {
    if (format === "json") return true;
    return (
      !!format &&
      typeof format === "object" &&
      (format as { type?: unknown }).type === "json"
    );
  });
}

function hasScreenshotFormat(options: unknown): boolean {
  const formats = (options as { formats?: unknown })?.formats;
  if (!Array.isArray(formats)) return false;
  return formats.some(format => {
    if (format === "screenshot") return true;
    return (
      !!format &&
      typeof format === "object" &&
      (format as { type?: unknown }).type === "screenshot"
    );
  });
}

function hasPdfParser(options: unknown): boolean {
  const parsers = (options as { parsers?: unknown })?.parsers;
  return Array.isArray(parsers) && parsers.includes("pdf");
}

function hasActions(options: unknown): boolean {
  const actions = (options as { actions?: unknown })?.actions;
  return Array.isArray(actions) && actions.length > 0;
}

function computeRefundPolicy(
  job: FeedbackJobRow,
  rating: FeedbackRating,
): { desiredRefund: number; policy: RefundPolicySnapshot } {
  const billedCredits = Math.max(0, job.credits_cost ?? 0);

  const none = (
    matchedReason: string,
    refundableRatings: FeedbackRating[] = [],
  ) => ({
    desiredRefund: 0,
    policy: {
      version: "feedback_refund_v1" as const,
      enabled: config.FEEDBACK_REFUND_ENABLED,
      endpoint: job.endpoint,
      mode: "none" as const,
      refundableRatings,
      matchedReason,
    },
  });

  if (!config.FEEDBACK_REFUND_ENABLED) {
    return none("refunds_disabled");
  }

  if (billedCredits <= 0) {
    return none("zero_billed_credits");
  }

  const flat = (
    flatCredits: number,
    matchedReason: string,
    refundableRatings: FeedbackRating[],
  ) => {
    if (!refundableRatings.includes(rating)) {
      return none("rating_not_refundable", refundableRatings);
    }
    return {
      desiredRefund: Math.min(flatCredits, billedCredits),
      policy: {
        version: "feedback_refund_v1" as const,
        enabled: true,
        endpoint: job.endpoint,
        mode: "flat" as const,
        refundableRatings,
        matchedReason,
        flatCredits,
        maxCredits: flatCredits,
      },
    };
  };

  const percentage = (
    percent: number,
    maxCredits: number,
    matchedReason: string,
    refundableRatings: FeedbackRating[],
  ) => {
    if (!refundableRatings.includes(rating)) {
      return none("rating_not_refundable", refundableRatings);
    }
    const calculated = Math.ceil(billedCredits * percent);
    return {
      desiredRefund: Math.min(calculated, maxCredits, billedCredits),
      policy: {
        version: "feedback_refund_v1" as const,
        enabled: true,
        endpoint: job.endpoint,
        mode: "percentage_with_cap" as const,
        refundableRatings,
        matchedReason,
        percent,
        maxCredits,
      },
    };
  };

  switch (job.endpoint) {
    case "search":
      return flat(1, "search_feedback", ["good", "partial", "bad"]);
    case "map":
      return flat(1, "map_feedback", ["partial", "bad"]);
    case "parse":
      return percentage(0.25, 10, "parse_feedback", ["partial", "bad"]);
    case "scrape":
      if (hasPdfParser(job.options)) {
        return percentage(0.25, 10, "scrape_pdf_feedback", ["partial", "bad"]);
      }
      if (hasJsonFormat(job.options)) {
        return percentage(0.25, 5, "scrape_json_feedback", ["partial", "bad"]);
      }
      if (hasActions(job.options) || hasScreenshotFormat(job.options)) {
        return percentage(0.25, 5, "scrape_addon_feedback", ["partial", "bad"]);
      }
      return flat(1, "scrape_feedback", ["partial", "bad"]);
  }
}

export async function recordEndpointFeedback(
  req: RequestWithAuth<any, any, any>,
  options: FeedbackRecordOptions,
): Promise<FeedbackRecordResult> {
  const logger = _logger.child({
    module: "api/v2",
    method: "recordEndpointFeedback",
    endpoint: options.endpoint,
    jobId: options.jobId,
    teamId: req.auth.team_id,
  });

  if (config.USE_DB_AUTHENTICATION !== true) {
    return fail(
      503,
      "DB_DISABLED",
      options.dbDisabledMessage ??
        "Feedback requires database authentication and is unavailable on this deployment.",
    );
  }

  if (isPreviewTeam(req.auth.team_id)) {
    return fail(
      403,
      "PREVIEW_TEAM_NOT_ALLOWED",
      "Feedback is not available for preview teams.",
    );
  }

  if (req.acuc?.flags?.searchFeedbackOptOut === true) {
    logger.info("Rejected feedback: team opted out");
    return fail(
      403,
      "TEAM_OPTED_OUT",
      "Feedback is disabled for this team. Contact support@firecrawl.com to re-enable.",
    );
  }

  const dbTeamId = normalizeTeamId(req.auth.team_id);

  try {
    let job: FeedbackJobRow | null;
    try {
      job = await lookupJobRow(options.endpoint, options.jobId, dbTeamId);
      if (!job) {
        await new Promise(resolve =>
          setTimeout(resolve, FEEDBACK_LOOKUP_RACE_RETRY_MS),
        );
        job = await lookupJobRow(options.endpoint, options.jobId, dbTeamId);
      }
    } catch (lookupErr) {
      logger.error("Failed to look up job for feedback", {
        error: lookupErr,
      });
      return fail(500, "INTERNAL", "Failed to look up job.");
    }

    if (!job) {
      return fail(
        404,
        options.notFoundCode ?? "JOB_NOT_FOUND",
        `${options.endpoint} job not found for this team.`,
      );
    }

    if (options.requireSuccessfulJob && job.is_successful === false) {
      return fail(
        409,
        options.failedJobCode ?? "INTERNAL",
        `Cannot submit feedback for a ${options.endpoint} job that did not succeed.`,
      );
    }

    const maxAgeSec = options.maxAgeSec ?? config.FEEDBACK_MAX_AGE_SEC;
    const maxAgeMs = maxAgeSec * 1000;
    const createdAtMs = new Date(job.created_at).getTime();
    if (Number.isNaN(createdAtMs)) {
      logger.warn("Job row had unparseable created_at", {
        created_at: job.created_at,
      });
    } else {
      const ageMs = Date.now() - createdAtMs;
      if (ageMs > maxAgeMs) {
        return fail(
          409,
          "FEEDBACK_WINDOW_EXPIRED",
          options.windowExpiredMessage ??
            `Feedback must be submitted within ${maxAgeSec} seconds of the job.`,
        );
      }
    }

    if (options.endpoint === "search") {
      const existingLegacy = await findExistingLegacySearchFeedback(
        options.jobId,
        dbTeamId,
      );
      if (existingLegacy) {
        const refundedToday = await sumEndpointCreditsRefundedToday(
          dbTeamId,
          options.endpoint,
          logger,
        );
        return {
          status: 200,
          body: {
            success: true,
            feedbackId: existingLegacy.id,
            creditsRefunded: 0,
            alreadySubmitted: true,
            creditsRefundedToday: refundedToday,
            dailyRefundCap:
              options.dailyCapCredits ?? config.FEEDBACK_DAILY_CAP_CREDITS,
            warning:
              "Feedback was already submitted for this search; no additional refund issued.",
          },
        };
      }
    }

    const feedbackId = uuidv7();
    const metadata = {
      ...(options.feedback.metadata ?? {}),
      ...(options.feedback.url ? { url: options.feedback.url } : {}),
      ...(options.feedback.pageNumbers
        ? { pageNumbers: options.feedback.pageNumbers }
        : {}),
    };

    const { error: insertErr } = await supabase_service
      .from("endpoint_feedback")
      .insert({
        id: feedbackId,
        endpoint: options.endpoint,
        job_id: options.jobId,
        request_id: job.request_id,
        api_version: "v2",
        team_id: dbTeamId,
        api_key_id: req.acuc?.api_key_id ?? null,
        rating: options.feedback.rating,
        issue_types: options.feedback.issues ?? [],
        tags: options.feedback.tags ?? [],
        comment: options.feedback.note ?? null,
        valuable_sources: options.feedback.valuableSources ?? [],
        missing_content: options.feedback.missingContent ?? [],
        query_suggestions: options.feedback.querySuggestions ?? null,
        expected: options.feedback.expected ?? null,
        actual: options.feedback.actual ?? null,
        metadata,
        job_status: job.is_successful === false ? "failed" : "completed",
        credits_billed: job.credits_cost ?? 0,
        credits_refunded: 0,
        refund_policy: null,
        integration: options.feedback.integration ?? null,
        origin: options.feedback.origin ?? null,
      });

    if (insertErr) {
      if ((insertErr as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        const { data: existing } = await supabase_rr_service
          .from("endpoint_feedback")
          .select("id, credits_refunded")
          .eq("team_id", dbTeamId)
          .eq("endpoint", options.endpoint)
          .eq("job_id", options.jobId)
          .single();

        const refundedToday = await sumEndpointCreditsRefundedToday(
          dbTeamId,
          options.endpoint,
          logger,
        );

        return {
          status: 200,
          body: {
            success: true,
            feedbackId: existing?.id ?? "",
            creditsRefunded: 0,
            alreadySubmitted: true,
            creditsRefundedToday: refundedToday,
            dailyRefundCap:
              options.dailyCapCredits ?? config.FEEDBACK_DAILY_CAP_CREDITS,
            warning:
              "Feedback was already submitted for this job; no additional refund issued.",
          },
        };
      }

      logger.error("Failed to insert endpoint feedback", { error: insertErr });
      return fail(500, "INTERNAL", "Failed to record feedback.");
    }

    const dailyCap =
      options.dailyCapCredits ?? config.FEEDBACK_DAILY_CAP_CREDITS;
    const refundedTodayBefore = await sumEndpointCreditsRefundedToday(
      dbTeamId,
      options.endpoint,
      logger,
    );
    const remainingDailyCap = Math.max(0, dailyCap - refundedTodayBefore);

    const { desiredRefund, policy } = computeRefundPolicy(
      job,
      options.feedback.rating,
    );
    const cappedRefund = Math.min(desiredRefund, remainingDailyCap);

    let creditsRefunded = 0;
    let dailyCapReached = false;

    if (desiredRefund > 0 && cappedRefund === 0) {
      dailyCapReached = true;
      logger.info(
        "Daily refund cap reached for team; feedback recorded with zero refund",
        { dailyCap, refundedTodayBefore },
      );
    } else if (cappedRefund > 0) {
      try {
        await autumnService.refundCredits({
          teamId: req.auth.team_id,
          value: cappedRefund,
          properties: {
            source: options.source,
            endpoint: options.endpoint,
            jobId: options.jobId,
            feedbackId,
            rating: options.feedback.rating,
            refundPolicy: policy.matchedReason,
          },
        });
        creditsRefunded = cappedRefund;
      } catch (error) {
        logger.error("Feedback refund failed; feedback retained", { error });
      }
    }

    const { error: updateErr } = await supabase_service
      .from("endpoint_feedback")
      .update({
        credits_refunded: creditsRefunded,
        refund_policy: policy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", feedbackId);

    if (updateErr) {
      logger.warn("Failed to persist endpoint feedback refund details", {
        error: updateErr,
        feedbackId,
        creditsRefunded,
      });
    }

    if (options.endpoint === "search") {
      await mirrorSearchFeedback(
        feedbackId,
        options.jobId,
        dbTeamId,
        options.feedback,
        creditsRefunded,
        logger,
      );
    }

    const creditsRefundedToday = refundedTodayBefore + creditsRefunded;
    if (!dailyCapReached && creditsRefundedToday >= dailyCap && dailyCap > 0) {
      dailyCapReached = true;
    }

    logger.info("Endpoint feedback recorded", {
      feedbackId,
      endpoint: options.endpoint,
      creditsRefunded,
      creditsBilled: job.credits_cost ?? 0,
      rating: options.feedback.rating,
      issueTypes: options.feedback.issues ?? [],
      refundPolicy: policy.matchedReason,
      creditsRefundedToday,
      dailyRefundCap: dailyCap,
      dailyCapReached,
    });

    return {
      status: 200,
      body: {
        success: true,
        feedbackId,
        creditsRefunded,
        creditsRefundedToday,
        dailyRefundCap: dailyCap,
        ...(dailyCapReached
          ? {
              dailyCapReached: true,
              warning: `Daily refund cap of ${dailyCap} credits reached for this team (UTC day). Feedback was recorded; further /feedback calls today will not refund credits.`,
            }
          : {}),
      },
    };
  } catch (error) {
    captureExceptionWithZdrCheck(error);
    logger.error("Unhandled error while recording endpoint feedback", {
      error,
    });
    return fail(
      500,
      "INTERNAL",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export async function feedbackController(
  req: RequestWithAuth<{}, EndpointFeedbackResponse, EndpointFeedbackRequest>,
  res: Response<EndpointFeedbackResponse>,
) {
  let parsedBody: EndpointFeedbackRequest;
  try {
    parsedBody = endpointFeedbackSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
        feedbackErrorCode: "INVALID_BODY",
      });
    }
    throw error;
  }

  const result = await recordEndpointFeedback(req, {
    endpoint: parsedBody.endpoint,
    jobId: parsedBody.jobId,
    feedback: toFeedbackInput(parsedBody),
    source: "endpoint_feedback",
  });

  return res.status(result.status).json(result.body);
}

export function toSearchFeedbackInput(
  body: SearchFeedbackRequest,
): FeedbackInput {
  return toFeedbackInput(body);
}
