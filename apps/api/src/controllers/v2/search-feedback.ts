import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  RequestWithAuth,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
  searchFeedbackSchema,
} from "./types";
import { recordEndpointFeedback, toSearchFeedbackInput } from "./feedback";

export async function searchFeedbackController(
  req: RequestWithAuth<
    { jobId: string },
    SearchFeedbackResponse,
    SearchFeedbackRequest
  >,
  res: Response<SearchFeedbackResponse>,
) {
  const searchId = req.params.jobId;
  const logger = _logger.child({
    module: "api/v2",
    method: "searchFeedbackController",
    searchId,
    teamId: req.auth.team_id,
  });

  let parsedBody: SearchFeedbackRequest;
  try {
    parsedBody = searchFeedbackSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid feedback body", { error: error.issues });
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
    endpoint: "search",
    jobId: searchId,
    feedback: toSearchFeedbackInput(parsedBody),
    requireSuccessfulJob: true,
    notFoundCode: "SEARCH_NOT_FOUND",
    failedJobCode: "SEARCH_FAILED",
    dbDisabledMessage:
      "Search feedback requires database authentication and is unavailable on this deployment.",
    windowExpiredMessage: `Search feedback must be submitted within ${config.SEARCH_FEEDBACK_MAX_AGE_SEC} seconds of the search.`,
    maxAgeSec: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
    dailyCapCredits: config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
    source: "search_feedback",
  });

  return res.status(result.status).json(result.body);
}
